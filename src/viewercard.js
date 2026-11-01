// The viewer card (click a nickname in the dashboard chat), modelled on Chzzk's own chat popup:
// profile picture, badges, "… 부터 팔로우", message / 임시 제한 / 활동 제한 counts, and the 관리 actions
// (상단 고정, 채팅 운영자, 임시 제한, 활동 제한, 메시지 삭제).
//
// Chzzk's official Open API only covers blinding a message, so everything else goes the way
// chzzk.naver.com itself does it: Chzzk's web endpoints, called from inside the 리모컨 dock in OBS
// (remote.request), which is logged in as the streamer. Endpoint shapes are from the open-source
// "chzzk" client (kimcore/chzzk) — unofficial, so they can break; failures say what Chzzk answered.
// Without the dock: the profile card is fetched anonymously (no counts, no actions).

const CARD_TTL = 60 * 1000;

const fmtFollow = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
  return m ? `${m[1]}년 ${Number(m[2])}월 ${Number(m[3])}일` : '';
};

export class ViewerCard {
  constructor({ chzzk, remote, chzzkOpen }) {
    this.chzzk = chzzk;
    this.remote = remote;
    this.open = chzzkOpen;
    this.cache = new Map(); // uid → { at, card }
  }

  get cfg() { return this.chzzk.cfg; }
  _game(path) { return `${this.cfg.gameApiBase}/nng_main${path}`; }
  _manage(path) { return `${this.cfg.apiBase}/manage/v1/channels/${this.chzzk.channelId}${path}`; }
  _canManage() { const r = this.remote.status(); return r.connected && !r.needsLogin; }

  async card(uid) {
    uid = String(uid || '');
    if (!/^[0-9a-f]{32}$/i.test(uid)) return { profile: null, counts: null, canManage: false };
    const hit = this.cache.get(uid);
    if (hit && Date.now() - hit.at < CARD_TTL) return hit.card;
    const cid = this.chzzk.chatChannelId;
    const errors = [];
    let profile = null, counts = null;
    if (cid) {
      const url = this._game(`/v1/chats/${cid}/users/${uid}/profile-card?chatType=STREAMING`);
      try {
        const p = this._canManage() ? await this.remote.request(url) : await this.chzzk._get(url);
        profile = this._profile(p);
      } catch (e) { errors.push(`프로필: ${e.message}`); }
    }
    if (this._canManage() && this.chzzk.channelId) {
      try {
        const c = await this.remote.request(this._manage(`/users/${uid}/chat-activity-count`));
        counts = {
          messages: Number(c?.chatMessageCount) || 0,
          tempRestricts: Number(c?.temporaryRestrictCount) || 0,
          restricts: Number(c?.restrictCount) || 0,
          tempRestricted: !!c?.temporaryRestrict,
          restricted: !!c?.restrict,
        };
      } catch (e) { errors.push(`채팅 기록: ${e.message}`); }
    }
    const card = { profile, counts, canManage: this._canManage(), errors };
    if (profile || counts) this.cache.set(uid, { at: Date.now(), card });
    if (this.cache.size > 300) this.cache.delete(this.cache.keys().next().value);
    return card;
  }

  _profile(p) {
    if (!p) return null;
    const sp = p.streamingProperty || {};
    const sub = sp.subscription;
    const badges = [
      sp.realTimeDonationRanking?.badge?.imageUrl,
      ...(p.viewerBadges || []).map((v) => v?.badge?.imageUrl),
      ...(p.activityBadges || []).filter((b) => b.activated !== false).map((b) => b.imageUrl),
    ].filter(Boolean);
    const role = p.userRoleCode === 'streamer' ? 'streamer' : /manager/.test(p.userRoleCode || '') ? 'manager' : '';
    return {
      nick: p.nickname || '',
      image: p.profileImageUrl || '',
      role,
      roleCode: p.userRoleCode || '',
      verified: p.verifiedMark === true,
      sub: sub ? { months: Number(sub.accumulativeMonth) || 0, tier: Number(sub.tier) || 1, img: sub.badge?.imageUrl || '' } : null,
      badges: [...new Set(badges)].slice(0, 6),
      followDate: fmtFollow(sp.following?.followDate),
    };
  }

  // action: notice | blind | manager | unmanager | temp | restrict | unrestrict
  async act(action, uid, msgId) {
    uid = String(uid || '');
    if (!/^[0-9a-f]{32}$/i.test(uid)) throw new Error('치지직 시청자가 아니에요');
    if (uid === this.chzzk.channelId) throw new Error('내 채널에는 할 수 없어요');
    const cid = this.chzzk.chatChannelId;
    const ch = this.chzzk.channelId;
    const m = msgId ? this.chzzk.chat.find((x) => x.id === Number(msgId) && x.uid === uid) : null;
    const needMsg = () => { if (!m) throw new Error('그 메시지를 찾지 못했어요 (채팅 목록에서 지워졌을 수 있어요)'); };
    const needDock = () => { if (!this._canManage()) throw new Error('OBS의 치지직 리모컨 독(네이버 로그인)이 필요해요'); };
    const msgBody = () => ({
      channelId: cid, chatType: 'STREAMING', message: m.text, messageTime: m.time, messageUserIdHash: uid, streamingChannelId: ch,
    });
    let done;
    switch (action) {
      case 'notice':
        needMsg(); needDock();
        await this.remote.request(this._game('/v1/chats/notices'), { method: 'POST', body: { ...msgBody(), extras: JSON.stringify({ chatType: 'STREAMING', emojis: m.emojis || {}, osType: 'PC', streamingChannelId: ch }) } });
        done = '메시지를 상단에 고정했어요';
        break;
      case 'blind':
        needMsg();
        // the official Open API first (채팅 메시지 쓰기 scope, already used for sending), then the dock
        if (this.open.status().loggedIn) {
          try {
            await this.open.api('POST', '/open/v1/chats/blind-message', { chatChannelId: cid, messageTime: m.time, senderChannelId: uid });
            done = '메시지를 삭제했어요';
            break;
          } catch (e) {
            console.log(`[card] blind via Open API failed (${e.message}) — trying the 리모컨 dock`);
            if (!this._canManage()) throw e;
          }
        }
        needDock();
        await this.remote.request(this._game('/v1/chats/blind-message'), { method: 'POST', body: msgBody() });
        done = '메시지를 삭제했어요';
        break;
      case 'manager':
        needDock();
        await this.remote.request(this._manage('/streaming-roles'), { method: 'POST', body: { targetId: uid, userRoleType: 'STREAMING_CHAT_MANAGER' } });
        done = '채팅 운영자로 임명했어요';
        break;
      case 'unmanager':
        needDock();
        await this.remote.request(this._manage(`/streaming-roles/${uid}`), { method: 'DELETE' });
        done = '채팅 운영자에서 해제했어요';
        break;
      case 'temp':
        needDock();
        await this.remote.request(this._manage('/temporary-restrict-users'), { method: 'POST', body: { chatChannelId: cid, targetId: uid } });
        done = '임시 제한했어요';
        break;
      case 'restrict':
        needDock();
        await this.remote.request(this._manage('/restrict-users'), { method: 'POST', body: { targetId: uid } });
        done = '활동 제한했어요';
        break;
      case 'unrestrict':
        needDock();
        await this.remote.request(this._manage(`/restrict-users/${uid}`), { method: 'DELETE' });
        done = '활동 제한을 풀었어요';
        break;
      default:
        throw new Error('알 수 없는 동작');
    }
    console.log(`[card] ${action} ${uid.slice(0, 8)}…${m ? ` (message at ${new Date(m.time).toISOString()})` : ''}: ok`);
    this.cache.delete(uid);
    return { done };
  }
}
