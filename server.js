// Donkey – authoritative game server. Run: node server.js
const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUB = __dirname;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

const AVATARS = ['🦁','🐯','🐼','🦊','🐸','🐵','🦄','🐶','🐱','🐙','🦉','🐢','🐧','🐘','🦖','🐰'];
const MAX_PLAYERS = 5;
const BOT_NAMES = ['Bolt', 'Pixel', 'Turbo', 'Nova', 'Zippy'], BOT_AVATARS = ['🤖', '👾', '🎃', '🧠', '🛸'];
// Optional Discord voice-chat invite. Set DISCORD_INVITE on Render to give every room a default link; players can also paste one per room.
const VOICE_RE = /^https:\/\/(discord\.gg|(www\.)?discord(app)?\.com\/invite)\/[A-Za-z0-9-]{2,40}$/;
const DEFAULT_VOICE = VOICE_RE.test(process.env.DISCORD_INVITE || '') ? process.env.DISCORD_INVITE : '';
const LOBBY_MS = Number(process.env.LOBBY_MS) || 10000; // time to show the result before returning to the lobby
const BOT_MS = Number(process.env.BOT_MS) || 1000;

const server = http.createServer((req, res) => {
  let u = decodeURIComponent(req.url.split('?')[0]);
  if (u === '/') u = '/index.html';
  const f = path.resolve(PUB, '.' + u);
  if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.statusCode = 404; return res.end('Not found'); }
  res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream');
  fs.createReadStream(f).pipe(res);
});

// ---------- game logic (cards are 0..51; suit = floor(c/13): 0♠ 1♣ 2♦ 3♥; rank = c%13+2, Ace = 14) ----------
const su = c => Math.floor(c / 13), rk = c => c % 13 + 2, ACE_SPADES = 12;
const SYM = ['♠', '♣', '♦', '♥'], RL = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const name = c => (RL[rk(c)] || rk(c)) + SYM[su(c)];
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

// 2 and 3 players: 39 cards (75% of a deck, picked at random). 4-5 players: the full 52-card deck.
// Cards are dealt one by one; when the count does not divide evenly, a random player gets the extra card(s).
// The Ace of Spades is always among the dealt cards, so someone can start.
function newGame(room) {
  clearTimeout(room.lobbyTimer); room.lobbyTimer = null;
  const n = room.players.length;
  const total = n <= 3 ? 39 : 52;
  let hands;
  do {
    const pool = shuffle([...Array(52).keys()]).slice(0, total);
    hands = Array.from({ length: n }, () => []);
    const start = Math.floor(Math.random() * n);
    pool.forEach((c, i) => hands[(start + i) % n].push(c));
  } while (!hands.some(h => h.includes(ACE_SPADES)));
  const first = hands.findIndex(h => h.includes(ACE_SPADES));
  room.game = { hands, trick: [], turn: first, lead: -1, first: true, winner: -1, last: [], seq: 0, seen: [], voids: Array.from({ length: n }, () => []),
    msg: room.players[first].name + ' holds the Ace of Spades and starts.' };
}
function playable(g, i) {
  const h = g.hands[i];
  if (g.first) return h.includes(ACE_SPADES) ? [ACE_SPADES] : [];
  if (!g.trick.length) return h;
  const f = h.filter(c => su(c) === g.lead);
  return f.length ? f : h;
}
function playCore(room, i, c) {
  const g = room.game, P = room.players, n = P.length;
  if (!g || g.winner >= 0 || g.turn !== i || !playable(g, i).includes(c)) return false;
  g.hands[i].splice(g.hands[i].indexOf(c), 1);
  g.seq++;
  if (!g.trick.length) { g.lead = su(c); g.first = false; }
  const off = su(c) !== g.lead;
  g.trick.push({ p: i, c, off });
  if (!off && g.trick.length < n) { g.turn = (i + 1) % n; g.msg = P[i].name + ' played ' + name(c) + '.'; return true; }
  // The round ends: everyone followed suit, or someone had no card of the lead suit.
  const t = g.trick;
  let next;
  if (off) {
    // Everyone before the cutter followed suit: the highest of those cards picks up the whole table.
    const hi = t.filter(x => !x.off).sort((a, b) => rk(b.c) - rk(a.c))[0];
    g.hands[hi.p].push(...t.map(x => x.c));
    g.voids[i][g.lead] = true; g.voids[hi.p] = [];   // bots remember who had no card of a suit
    g.msg = P[i].name + ' had no ' + SYM[g.lead] + '. ' + P[hi.p].name + ' (highest: ' + name(hi.c) + ') picks up ' + t.length + ' cards.';
    next = hi.p;
  } else {
    const top = t.slice().sort((a, b) => rk(b.c) - rk(a.c))[0];
    g.msg = 'Round over. ' + name(top.c) + ' by ' + P[top.p].name + ' is highest; cards set aside.';
    next = top.p;
    g.seen.push(...t.map(x => x.c));              // cards set aside are out of the game
  }
  g.last = t; g.trick = []; g.turn = next; g.lead = -1;
  const fin = t.map(x => x.p).concat([next]).find(k => g.hands[k].length === 0);
  if (fin !== undefined) g.winner = fin;
  return true;
}

// ---------- bot brains ----------
const LEVELS = ['easy', 'medium', 'hard'];
const maxBy = (a, f) => a.reduce((b, x) => (f(x) > f(b) ? x : b));
const minBy = (a, f) => a.reduce((b, x) => (f(x) < f(b) ? x : b));
const topOf = list => list.slice().sort((a, b) => rk(b.c) - rk(a.c))[0];   // earliest wins a tie
function legal(hand, trick, lead) {
  if (!trick.length) return hand;
  const f = hand.filter(c => su(c) === lead);
  return f.length ? f : hand;
}
// MEDIUM: stay out of trouble. Follow suit with a card lower than the best one on the table when possible
// (so someone else picks up), dump the highest card when it has no suit, lead with the lowest card.
function mediumPick(hand, trick, lead, n) {
  const ok = legal(hand, trick, lead);
  if (!trick.length) return minBy(ok, c => rk(c) + Math.random() * 0.01);
  if (!hand.some(c => su(c) === lead)) return maxBy(ok, c => rk(c) + Math.random() * 0.01);
  const cur = Math.max(...trick.filter(x => !x.off).map(x => rk(x.c)));
  const lower = ok.filter(c => rk(c) < cur);
  if (lower.length) return maxBy(lower, rk);
  return trick.length === n - 1 ? maxBy(ok, rk) : minBy(ok, rk);   // last to play: round just ends, so dump the high card
}
// Play out the rest of ONE round (others use the medium brain). Returns who picks up the table (-1 = cards set aside).
function simRound(hands, trick, lead, turn, n, first) {
  trick = trick.map(x => ({ ...x }));
  let c = first;
  for (;;) {
    const h = hands[turn]; h.splice(h.indexOf(c), 1);
    if (!trick.length) lead = su(c);
    const off = su(c) !== lead;
    trick.push({ p: turn, c, off });
    if (off) { const hi = topOf(trick.filter(x => !x.off)); hands[hi.p].push(...trick.map(x => x.c)); return { picker: hi.p, size: trick.length, next: hi.p }; }
    if (trick.length >= n) return { picker: -1, size: trick.length, next: topOf(trick).p };
    turn = (turn + 1) % n;
    c = mediumPick(hands[turn], trick, lead, n);
  }
}
// Guess the hidden hands of the players still to act, using only what a real player could know
// (cards set aside, the table, and which players failed to follow a suit earlier).
function sampleHands(unknown, rest, sizes, voids) {
  for (let attempt = 0; attempt < 25; attempt++) {
    const pool = shuffle(unknown.slice()), out = {}; let ok = true;
    for (const p of rest) {
      const take = [];
      for (let k = pool.length - 1; k >= 0 && take.length < sizes[p]; k--) if (!voids[p][su(pool[k])]) { take.push(pool[k]); pool.splice(k, 1); }
      if (take.length < sizes[p]) { ok = false; break; }
      out[p] = take;
    }
    if (ok) return out;
  }
  const pool = shuffle(unknown.slice()), out = {};
  for (const p of rest) out[p] = pool.splice(0, sizes[p]);
  return out;
}
// HARD: remembers set-aside cards and who is out of a suit, imagines many possible hands for the players still
// to act, plays out the round for every candidate card and picks the one that leaves it with the fewest cards.
function hardPick(room, i, ok) {
  const g = room.game, n = room.players.length, cand = [...new Set(ok)];
  const known = new Set([...g.hands[i], ...g.trick.map(x => x.c), ...g.seen]), unknown = [];
  for (let c = 0; c < 52; c++) if (!known.has(c)) unknown.push(c);
  const acted = new Set(g.trick.map(x => x.p)), rest = [], sizes = g.hands.map(h => h.length);
  for (let k = 1; k < n; k++) { const p = (i + k) % n; if (acted.has(p)) break; rest.push(p); }
  const total = new Map(cand.map(c => [c, 0])), SAMPLES = 60;
  for (let s = 0; s < SAMPLES; s++) {
    const hs = sampleHands(unknown, rest, sizes, g.voids);
    for (const c of cand) {
      const hands = g.hands.map(h => h.slice()); rest.forEach(p => { hands[p] = hs[p].slice(); });
      const r = simRound(hands, g.trick, g.lead, i, n, c);
      let sc = r.picker === i ? -(r.size - 1) : 1;
      if (r.picker !== -1 && r.picker !== i) sc += 0.7 * r.size;     // making someone else pick up is good
      if (r.picker !== i) sc += 0.03 * rk(c);                         // get rid of high cards when it is safe
      const mine = hands[i].length, others = hands.filter((h, p) => p !== i && g.hands[p].length > 0).map(h => h.length);
      if (others.length) sc += 0.5 * (Math.min(...others) - mine);      // stay ahead in the race to finish
      total.set(c, total.get(c) + sc);
    }
  }
  return maxBy(cand, c => total.get(c) + Math.random() * 0.01);
}
function botPick(room, i, level) {
  const g = room.game, ok = playable(g, i);
  if (ok.length <= 1 || !LEVELS.includes(level) || level === 'easy') return ok[Math.floor(Math.random() * ok.length)];
  if (level === 'medium') return mediumPick(g.hands[i], g.trick, g.lead, room.players.length);
  return hardPick(room, i, ok);
}

function play(room, i, c) { if (!playCore(room, i, c)) return false; checkEarly(room); return true; }

// Early finish: the player whose turn it is holds cards of ONE suit only, and has to play that suit
// (leading it, or following it). If the next player has none of that suit, the game ends and the next player wins.
function checkEarly(room) {
  const g = room.game, n = room.players.length;
  if (!g || g.winner >= 0) return;
  const x = g.turn, hand = g.hands[x];
  if (!hand.length) return;
  const s = su(hand[0]);
  if (!hand.every(c => su(c) === s)) return;
  if (g.trick.length && g.lead !== s) return;   // x must follow a different suit, so the rule does not apply
  if (g.trick.length + 1 >= n) return;          // x is last to play: the round simply ends with x's card
  const y = (x + 1) % n;
  if (!g.hands[y].length || g.hands[y].some(c => su(c) === s)) return;
  g.winner = y; g.early = true;
  g.msg = room.players[y].name + ' has no ' + SYM[s] + ' while ' + room.players[x].name + ' holds only ' + SYM[s] + '. ' + room.players[y].name + ' wins!';
}
// After a game ends, everybody goes back to the lobby (room screen) to change avatars, add bots and deal again.
function toLobby(room) {
  clearTimeout(room.lobbyTimer); room.lobbyTimer = null;
  room.game = null;
  room.players = room.players.filter(x => x.ws || x.bot);
  if (!room.players.some(p => !p.bot)) { clearTimeout(room.botTimer); rooms.delete(room.code); return; }
  push(room);
}

// ---------- rooms ----------
const rooms = new Map(); // code -> { code, players:[{sub,name,ws}], game, touched }
function send(ws, o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
function push(room) {
  room.touched = Date.now();
  if (room.game && room.game.winner >= 0 && !room.lobbyTimer) room.lobbyTimer = setTimeout(() => { room.lobbyTimer = null; if (room.game && room.game.winner >= 0) toLobby(room); }, LOBBY_MS);
  room.players.forEach((p, idx) => {
    const g = room.game;
    send(p.ws, { type: 'state', room: room.code, me: idx,
      voice: room.voice || DEFAULT_VOICE,
      players: room.players.map(q => ({ name: q.name, online: q.bot || !!q.ws, avatar: q.avatar, bot: !!q.bot, level: q.level })),
      game: g && { counts: g.hands.map(h => h.length), hand: g.hands[idx], trick: g.trick, last: g.last,
        turn: g.turn, lead: g.lead, first: g.first, seq: g.seq, winner: g.winner, early: !!g.early, msg: g.msg, ok: g.winner < 0 ? playable(g, idx) : [] } });
  });
  schedBot(room);
}
// Easy bot: plays a random legal card after a short pause.
function schedBot(room) {
  const g = room.game;
  if (!g || g.winner >= 0 || room.botTimer) return;
  const p = room.players[g.turn];
  if (!p || !p.bot) return;
  room.botTimer = setTimeout(() => {
    room.botTimer = null;
    const g2 = room.game;
    if (!g2 || g2.winner >= 0) return;
    const i = g2.turn, b = room.players[i];
    if (!b || !b.bot) return;
    if (playable(g2, i).length && play(room, i, botPick(room, i, b.level))) push(room);
  }, BOT_MS + Math.random() * BOT_MS * 0.7);
}
function leave(ws) {
  const room = ws.room; if (!room) return;
  const p = room.players.find(x => x.ws === ws);
  if (p) p.ws = null;
  if (!room.game) room.players = room.players.filter(x => x.ws || x.bot); // free the seat if no game started
  ws.room = null;
  if (!room.players.some(p => !p.bot)) { clearTimeout(room.botTimer); rooms.delete(room.code); } else push(room);
}
setInterval(() => { const now = Date.now(); for (const [k, r] of rooms) if (now - r.touched > 6 * 3600e3 && r.players.every(p => !p.ws)) rooms.delete(k); }, 600e3);

const wss = new WebSocketServer({ server });
wss.on('connection', ws => {
  ws.user = null; ws.room = null;
  ws.on('message', async raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    try {
      if (m.type === 'join') {
        const pid = String(m.pid || '').slice(0, 40), nm = String(m.name || '').trim().slice(0, 14) || 'Player';
        if (pid.length < 8) return send(ws, { type: 'error', text: 'Invalid client.' });
        ws.user = { sub: pid, name: nm };
        const code = String(m.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
        if (!code) return send(ws, { type: 'error', text: 'Enter a room code.' });
        leave(ws);
        let room = rooms.get(code);
        if (!room) { room = { code, players: [], game: null, touched: Date.now() }; rooms.set(code, room); }
        let p = room.players.find(x => x.sub === ws.user.sub);
        if (p) { if (p.ws && p.ws !== ws) { p.ws.room = null; send(p.ws, { type: 'error', text: 'Signed in on another device.' }); } p.ws = ws; }
        else if (room.game || room.players.length >= MAX_PLAYERS) return send(ws, { type: 'error', text: 'This room is full or the game has already started (max ' + MAX_PLAYERS + ' players).', left: true });
        else {
          const taken = new Set(room.players.map(q => q.avatar));
          const av = AVATARS.includes(m.avatar) && !taken.has(m.avatar) ? m.avatar : AVATARS.find(x => !taken.has(x));
          room.players.push({ sub: ws.user.sub, name: ws.user.name, ws, avatar: av });
        }
        ws.room = room; return push(room);
      }
      const room = ws.room; if (!room) return;
      const idx = room.players.findIndex(x => x.ws === ws);
      if (m.type === 'avatar') {
        if (!room.game && idx >= 0 && AVATARS.includes(m.a) && !room.players.some((q, k) => k !== idx && q.avatar === m.a)) { room.players[idx].avatar = m.a; push(room); }
        return;
      }
      if (m.type === 'voice') {
        const u = String(m.url || '').trim().slice(0, 100);
        if (idx >= 0 && (u === '' || VOICE_RE.test(u))) { room.voice = u; return push(room); }
        return send(ws, { type: 'error', text: 'Please paste a Discord invite link, like https://discord.gg/abc123' });
      }
      if (m.type === 'addbot') {
        if (room.game || idx < 0 || room.players.length >= MAX_PLAYERS) return;
        const nb = room.players.filter(q => q.bot).length;
        room.players.push({ sub: 'bot-' + Date.now() + '-' + nb, name: 'Bot ' + BOT_NAMES[nb % BOT_NAMES.length], ws: null, bot: true, level: LEVELS.includes(m.level) ? m.level : 'easy', avatar: BOT_AVATARS[nb % BOT_AVATARS.length] });
        return push(room);
      }
      if (m.type === 'rmbot') {
        if (room.game || idx < 0) return;
        for (let k = room.players.length - 1; k >= 0; k--) if (room.players[k].bot) { room.players.splice(k, 1); break; }
        return push(room);
      }
      if (m.type === 'lobby' || m.type === 'again') { if (room.game && room.game.winner >= 0) toLobby(room); return; }
      if (m.type === 'start') {
        if (room.players.length < 2) return send(ws, { type: 'error', text: 'Need at least 2 players.' });
        if (room.game) return;
        newGame(room); checkEarly(room); return push(room);
      }
      if (m.type === 'play' && play(room, idx, m.card)) return push(room);
    } catch (e) { console.error(e); }
  });
  ws.on('close', () => leave(ws));
});
server.listen(PORT, () => console.log('Donkey running on :' + PORT));
