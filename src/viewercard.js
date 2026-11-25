// The viewer card (click a nickname in the dashboard chat), modelled on Chzzk's own chat popup:
// profile picture, badges, subscription, and the 관리 actions (공지, 임시 제한, 활동 제한, 메시지 숨기기).
//
// Everything goes through CHZZK's OFFICIAL Open API with the owner's login (docs/plans/chzzk-official.md, docs read 2026-11-25):
//   profile      GET  /open/v1/channels?channelIds=<uid>          (Client-Id/Secret): channelName, channelImageUrl, followerCount, verifiedMark
//   임시 제한    POST /open/v1/temporary-restrict-channels         { targetChannelId, chatChannelId }           (활동제한 쓰기)
//   활동 제한    POST|DELETE /open/v1/restrict-channels            { targetChannelId }                         (활동제한 쓰기)
//   restricted?  GET  /open/v1/restrict-channels                   (활동제한 조회, 30 per page)
//   숨기기       POST /open/v1/chats/blind-message                 { chatChannelId, messageTime, senderChannelId } (채팅 메시지 쓰기)
//   공지         POST /open/v1/chats/notice                        { message ≤ 100 chars }                     (채팅 공지 쓰기)
// What the official API cannot do and the card therefore does not show or do: follow date, message / restriction counts, and
// 채팅 운영자 임명 (the UI links to 치지직 스튜디오 instead). 숨기기 hides a message (it is not a delete); 공지 posts the text as a NEW
// notice, because chat events carry no message id to pin the viewer's own message with.
// Without an Open API login there are no actions; the profile then comes from the anonymous (unofficial) card of the fallback reader.

const CARD_TTL = 60 * 1000;
const NOTICE_MAX = 100;

const SCOPE_FOR = {
  blind: '채팅 메시지 쓰기',
  notice: '채팅 공지 쓰기',
  temp: '활동제한 쓰기',
  restrict: '활동제한 쓰기',
  unrestrict: '활동제한 쓰기',
};

export class ViewerCard {
  constructor({ chzzk, chzzkOpen, session = null }) {
    this.chzzk = chzzk;
    this.open = chzzkOpen;
    this.session = session;
    this.cache = new Map(); // uid → { at, card }
    this.restricted = { at: 0, ids: new Set(), ok: false };
  }

  get cfg() { return this.chzzk.cfg; }
  _canManage() { return !!this.open?.loggedIn?.(); }

  async _restrictedSet() {
    const r = this.restricted;
    if (Date.now() - r.at < CARD_TTL) return r;
    const ids = new Set();
    let page;
    try {
      for (let i = 0; i < 20; i++) {
        const c = await this.open.api('GET', '/open/v1/restrict-channels', undefined, { query: { size: 30, ...(page ? { next: page } : {}) } });
        for (const x of c?.data || []) if (x?.restrictedChannelId) ids.add(String(x.restrictedChannelId));
        page = c?.page?.next;
        if (!page) break;
      }
      this.restricted = { at: Date.now(), ids, ok: true };
    } catch (e) {
      this.restricted = { at: Date.now(), ids: new Set(), ok: false, error: e };
    }
    return this.restricted;
  }

  async card(uid) {
    uid = String(uid || '');
    if (!/^[0-9a-f]{32}$/i.test(uid)) return { profile: null, counts: null, canManage: false };
    const hit = this.cache.get(uid);
    if (hit && Date.now() - hit.at < CARD_TTL) return hit.card;
    const errors = [];
    let profile = null;
    let counts = null;
    const seen = [...this.chzzk.chat].reverse().find((m) => m.uid === uid && m.platform !== 'youtube');
    if (this.open?.configured?.()) {
      try {
        const c = await this.open.api('GET', '/open/v1/channels', undefined, { user: false, query: { channelIds: uid } });
        const ch = (c?.data || [])[0];
        if (ch) {
          profile = {
            nick: ch.channelName || seen?.nick || '',
            image: ch.channelImageUrl || '',
            role: seen?.role || '',
            roleCode: '',
            verified: ch.verifiedMark === true,
            sub: this.session?.subs.get(uid) || seen?.sub || null,
            badges: seen?.badges || [],
            followDate: '', // not available through the official API
            followers: Number(ch.followerCount) || 0,
          };
        }
      } catch (e) { errors.push(`프로필: ${e.message}`); }
    }
    if (!profile && this.chzzk.mode !== 'official' && this.chzzk.chatChannelId) {
      // fallback reader only (no Open API app): the anonymous card, no counts, no actions
      try {
        const url = `${this.cfg.gameApiBase}/nng_main/v1/chats/${this.chzzk.chatChannelId}/users/${uid}/profile-card?chatType=STREAMING`;
        const p = await this.chzzk._get(url);
        if (p) profile = { nick: p.nickname || '', image: p.profileImageUrl || '', role: seen?.role || '', roleCode: p.userRoleCode || '', verified: p.verifiedMark === true, sub: seen?.sub || null, badges: seen?.badges || [], followDate: '' };
      } catch (e) { errors.push(`프로필: ${e.message}`); }
    }
    const can = this._canManage();
    if (can) {
      const r = await this._restrictedSet();
      if (r.ok) counts = { messages: null, tempRestricts: null, restricts: null, tempRestricted: null, restricted: r.ids.has(uid) };
    }
    const card = { profile, counts, canManage: can, errors };
    if (profile || counts) this.cache.set(uid, { at: Date.now(), card });
    if (this.cache.size > 300) this.cache.delete(this.cache.keys().next().value);
    return card;
  }

  _explain(action, e) {
    const st = e?.status;
    if (action === 'blind' && st === 400) return '스트리머 계정으로 로그인해야 메시지를 숨길 수 있어요';
    if (st === 403) return `권한이 없어요 — CHZZK Developers의 내 앱에서 "${SCOPE_FOR[action] || '필요한'}" 권한을 켜고 설정 창에서 치지직 로그인을 다시 해 주세요`;
    if (st === 404) return '그 메시지를 찾지 못했어요 (이미 사라졌거나 숨겨졌을 수 있어요)';
    if (st === 400) return `치지직이 거절했어요: ${e.apiMessage || e.message}`;
    return e?.message || '치지직 오류';
  }

  // action: notice | blind | temp | restrict | unrestrict   (채팅 운영자 is not in the official API: the UI links to the Studio)
  async act(action, uid, msgId) {
    uid = String(uid || '');
    if (!/^[0-9a-f]{32}$/i.test(uid)) throw new Error('치지직 시청자가 아니에요');
    if (uid === this.chzzk.channelId) throw new Error('내 채널에는 할 수 없어요');
    if (action === 'manager' || action === 'unmanager') throw new Error('채팅 운영자는 치지직 스튜디오에서 바꿔 주세요 (공식 API에 없어요)');
    if (!SCOPE_FOR[action]) throw new Error('알 수 없는 동작');
    if (!this._canManage()) throw new Error('치지직 연동 로그인이 필요해요 (설정 창 → 치지직 연동)');
    const m = msgId ? this.chzzk.chat.find((x) => x.id === Number(msgId) && x.uid === uid) : null;
    const needMsg = () => { if (!m) throw new Error('그 메시지를 찾지 못했어요 (채팅 목록에서 지워졌을 수 있어요)'); };
    const cid = (m && m.chatChannelId) || this.chzzk.chatChannelId;
    const needChatRoom = () => { if (!cid) throw new Error('채팅방 정보가 아직 없어요 — 채팅이 연결된 뒤에 다시 눌러 주세요'); };
    let done;
    try {
      switch (action) {
        case 'notice':
          needMsg();
          await this.open.api('POST', '/open/v1/chats/notice', { message: String(m.text || '').slice(0, NOTICE_MAX) });
          done = `공지로 올렸어요 (${NOTICE_MAX}자까지, 새 공지로 등록돼요)`;
          break;
        case 'blind':
          needMsg(); needChatRoom();
          await this.open.api('POST', '/open/v1/chats/blind-message', { chatChannelId: cid, messageTime: m.time, senderChannelId: uid });
          m.hidden = true;
          this.chzzk.emit('chat-update', m);
          done = '메시지를 숨겼어요';
          break;
        case 'temp':
          needChatRoom();
          await this.open.api('POST', '/open/v1/temporary-restrict-channels', { targetChannelId: uid, chatChannelId: cid });
          done = '임시 제한했어요';
          break;
        case 'restrict':
          await this.open.api('POST', '/open/v1/restrict-channels', { targetChannelId: uid });
          this.restricted.at = 0;
          done = '활동 제한했어요';
          break;
        case 'unrestrict':
          await this.open.api('DELETE', '/open/v1/restrict-channels', { targetChannelId: uid });
          this.restricted.at = 0;
          done = '활동 제한을 풀었어요';
          break;
        default:
          throw new Error('알 수 없는 동작');
      }
    } catch (e) {
      if (e.status) throw new Error(this._explain(action, e));
      throw e;
    }
    console.log(`[card] ${action} ${uid.slice(0, 8)}…${m ? ` (message at ${new Date(m.time).toISOString()})` : ''}: ok`);
    this.cache.delete(uid);
    return { done };
  }
}
