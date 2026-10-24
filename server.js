// Donkey – authoritative game server. Run: node server.js
const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUB = __dirname;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

const AVATARS = ['🦁','🐯','🐼','🦊','🐸','🐵','🦄','🐶','🐱','🐙','🦉','🐢','🐧','🐘','🦖','🐰'];
const MAX_PLAYERS = 5;

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

// 2 players: 13 cards each (26 of 52). 3 players: 13 each (39 of 52). 4-5 players: two decks split equally (26 / 20 each).
// The Ace of Spades is always among the dealt cards, so someone can start.
function newGame(room) {
  const n = room.players.length;
  const decks = n >= 4 ? 2 : 1, per = n >= 4 ? Math.floor(104 / n) : 13;
  let hands;
  do {
    const pool = [];
    for (let d = 0; d < decks; d++) for (let c = 0; c < 52; c++) pool.push(c);
    shuffle(pool);
    hands = Array.from({ length: n }, (_, i) => pool.slice(i * per, (i + 1) * per));
  } while (!hands.some(h => h.includes(ACE_SPADES)));
  const first = hands.findIndex(h => h.includes(ACE_SPADES));
  room.game = { hands, trick: [], turn: first, lead: -1, first: true, winner: -1, last: [],
    msg: room.players[first].name + ' holds the Ace of Spades and starts.' };
}
function playable(g, i) {
  const h = g.hands[i];
  if (g.first) return h.includes(ACE_SPADES) ? [ACE_SPADES] : [];
  if (!g.trick.length) return h;
  const f = h.filter(c => su(c) === g.lead);
  return f.length ? f : h;
}
function play(room, i, c) {
  const g = room.game, P = room.players, n = P.length;
  if (!g || g.winner >= 0 || g.turn !== i || !playable(g, i).includes(c)) return false;
  g.hands[i].splice(g.hands[i].indexOf(c), 1);
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
    g.msg = P[i].name + ' had no ' + SYM[g.lead] + '. ' + P[hi.p].name + ' (highest: ' + name(hi.c) + ') picks up ' + t.length + ' cards.';
    next = hi.p;
  } else {
    const top = t.slice().sort((a, b) => rk(b.c) - rk(a.c))[0];
    g.msg = 'Round over. ' + name(top.c) + ' by ' + P[top.p].name + ' is highest; cards set aside.';
    next = top.p;
  }
  g.last = t; g.trick = []; g.turn = next; g.lead = -1;
  const fin = t.map(x => x.p).concat([next]).find(k => g.hands[k].length === 0);
  if (fin !== undefined) g.winner = fin;
  return true;
}

// ---------- rooms ----------
const rooms = new Map(); // code -> { code, players:[{sub,name,ws}], game, touched }
function send(ws, o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
function push(room) {
  room.touched = Date.now();
  room.players.forEach((p, idx) => {
    const g = room.game;
    send(p.ws, { type: 'state', room: room.code, me: idx,
      players: room.players.map(q => ({ name: q.name, online: !!q.ws, avatar: q.avatar })),
      game: g && { counts: g.hands.map(h => h.length), hand: g.hands[idx], trick: g.trick, last: g.last,
        turn: g.turn, lead: g.lead, first: g.first, winner: g.winner, msg: g.msg, ok: g.winner < 0 ? playable(g, idx) : [] } });
  });
}
function leave(ws) {
  const room = ws.room; if (!room) return;
  const p = room.players.find(x => x.ws === ws);
  if (p) p.ws = null;
  if (!room.game) room.players = room.players.filter(x => x.ws); // free the seat if no game started
  ws.room = null;
  if (!room.players.length) rooms.delete(room.code); else push(room);
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
      if (m.type === 'start' || m.type === 'again') {
        if (room.players.length < 2) return send(ws, { type: 'error', text: 'Need at least 2 players.' });
        if (room.game && room.game.winner < 0) return;
        newGame(room); return push(room);
      }
      if (m.type === 'play' && play(room, idx, m.card)) return push(room);
    } catch (e) { console.error(e); }
  });
  ws.on('close', () => leave(ws));
});
server.listen(PORT, () => console.log('Donkey running on :' + PORT));
