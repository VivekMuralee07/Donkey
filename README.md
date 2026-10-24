# Donkey – 3-player card game (PWA + Node)

No accounts or sign-in. One player makes a room code, shares it, and the other two enter it. Max 3 players per room.
Works on Android and iOS as an installable web app.

## Run locally
```
npm install
npm start
```
Open http://localhost:3000 (other devices on your Wi-Fi: http://YOUR-PC-IP:3000).

## Put it online (free, example: Render.com)
1. Push this folder to a GitHub repo.
2. Render → New → Web Service → pick the repo. Build command: `npm install`. Start command: `npm start`.
3. Open the URL Render gives you. That is the link your friends use.
(Free tier sleeps after inactivity; the first load may take ~30 seconds.)

## Install on phones
- **Android (Chrome):** open the URL → menu → Install app.
- **iPhone (Safari):** open the URL → Share → Add to Home Screen.

## Play
Enter your name, tap "Make a random code" (or type one), tap Join. Share the code. When 3 are seated, anyone taps "Deal the cards".
If someone refreshes or loses signal, they re-enter the same name and code to take their seat back.

## Rules implemented
- 52 cards split 18/17/17. Ace of Spades holder starts and must play it; play goes clockwise.
- Ace high. Follow the lead suit if you can; the highest lead-suit card wins the round and leads next.
- No card of the lead suit? Give any card of your choice; the round's winner receives it.
- First to run out of cards wins; whoever holds the most cards is the Donkey.
