// Donkey – authoritative game server. Run: node server.js
const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUB = __dirname;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

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

function newGame(room) {
  const deck = shuffle([...Array(52).keys()]);
  const hands = [[], [], []];
  deck.forEach((c, i) => hands[i % 3].push(c));
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
  const g = room.game, P = room.players;
  if (!g || g.winner >= 0 || g.turn !== i || !playable(g, i).includes(c)) return false;
  g.hands[i].splice(g.hands[i].indexOf(c), 1);
  if (!g.trick.length) { g.lead = su(c); g.first = false; }
  const off = su(c) !== g.lead;
  g.trick.push({ p: i, c, off });
  if (g.trick.length < 3) { g.turn = (i + 1) % 3; g.msg = P[i].name + ' played ' + name(c) + (off ? ' (off-suit)' : '') + '.'; return true; }
  const inSuit = g.trick.filter(t => su(t.c) === g.lead).sort((a, b) => rk(b.c) - rk(a.c));
  const w = inSuit[0].p, gifts = g.trick.filter(t => t.off).map(t => t.c);
  g.hands[w].push(...gifts);
  g.msg = P[w].name + ' wins the round with ' + name(inSuit[0].c) + (gifts.length ? ' and receives ' + gifts.length + ' card(s).' : '.');
  g.last = g.trick; g.trick = []; g.turn = w; g.lead = -1;
  const done = [0, 1, 2].filter(k => g.hands[k].length === 0);
  if (done.length) g.winner = done[0];
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
      players: room.players.map(q => ({ name: q.name, online: !!q.ws })),
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
        else if (room.game || room.players.length >= 3) return send(ws, { type: 'error', text: 'This room is full (max 3 players).', left: true });
        else room.players.push({ sub: ws.user.sub, name: ws.user.name, ws });
        ws.room = room; return push(room);
      }
      const room = ws.room; if (!room) return;
      const idx = room.players.findIndex(x => x.ws === ws);
      if (m.type === 'start' || m.type === 'again') {
        if (room.players.length !== 3) return send(ws, { type: 'error', text: 'Need exactly 3 players.' });
        if (room.game && room.game.winner < 0) return;
        newGame(room); return push(room);
      }
      if (m.type === 'play' && play(room, idx, m.card)) return push(room);
    } catch (e) { console.error(e); }
  });
  ws.on('close', () => leave(ws));
});
server.listen(PORT, () => console.log('Donkey running on :' + PORT));
