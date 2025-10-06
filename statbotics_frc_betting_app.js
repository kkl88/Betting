/*
STATBOTICS FRC Betting App
File: statbotics-bet-app.js
Type: code/javascript

This is a single-file prototype for a GitHub App / microservice that implements the core
logic you described: an "FRC betting thingy" based on EPA, rankings, and win predictions.

Features included:
- Compute per-team "value" from: EPA (expected points), ranking position, and win probability.
- Combine three teams into an alliance value (addition), enforce minimum of 1.
- Rank multipliers mapping (configurable) — uses your 1 = 1.1 mapping and fills the rest.
- Lower win probability increases value (so an underdog is worth more).
- Simple REST API endpoints for predictions, alliance scoring, placing bets (in-memory).
- Example usage and sample data included below.

Notes / design decisions (interpretation):
- You wrote: "1 = 1.1" and left 2..8 blank. I used the following rank multipliers by default
  but you can change them in RANK_MULTIPLIERS constant.
- Team value formula (configurable):
    team_value = max(1, (epa_normalized * RANK_MULTIPLIER[rank] * (1 / (win_prob + EPS))))
  where epa_normalized scales EPA so typical values land near 1. This ensures the final value >= 1.
- Alliance value = sum(team_values) for the three alliance teams.
- Over/Under suggestion:
    - Using alliance expected total points = sum(team_epa) as base (EPA is per-team expected contribution)
    - We return a suggested over/under line and implied payout multiplier by comparing alliance_value.

This prototype intentionally focuses on the core algorithm and API; hooking it to live Statbotics
API or GitHub App webhooks can be added later.

Run locally:
  - Requires Node.js (v14+)
  - Save this file and run: node statbotics-bet-app.js
  - The server listens on port 3000 by default.

API endpoints:
  GET  /health                         -> simple status
  POST /predict                       -> body: {match_id, alliances: {red:[teamObjs], blue:[teamObjs]}}
                                         teamObj = {team_key, rank, epa, win_prob}
                                       -> returns computed values and over/under suggestion
  POST /bet                           -> place a bet (in-memory): {user, alliance, amount, type: 'over'|'under', line}
  GET  /bets                          -> list placed bets
  POST /simulate                      -> run quick sim of many matches (demo)

*/

const express = require('express');
const bodyParser = require('body-parser');
const app = express();
app.use(bodyParser.json());

// ------------------ CONFIG ------------------
const PORT = process.env.PORT || 3000;

// Rank multipliers. You provided `1 = 1.1` so I start there and make a gentle decay for ranks 2..8.
// Edit these values to tune the model. Lower multiplier -> lower "value" for that rank.
const RANK_MULTIPLIERS = {
  1: 1.10,
  2: 1.08,
  3: 1.06,
  4: 1.04,
  5: 1.02,
  6: 1.01,
  7: 1.005,
  8: 1.001
};

// Small epsilon to avoid division by zero with win probability
const EPS = 0.001;

// How we scale EPA into a normalized factor around 1. This is a tunable parameter.
// Statbotics EPAs vary by event; choose SCALE_EPA to make typical per-team EPA produce values ~1.
const SCALE_EPA = 10.0;

// Minimum allowed team value
const MIN_TEAM_VALUE = 1.0;

// In-memory bets store (replace with DB in production)
const bets = [];

// ------------------ CORE ALGORITHM ------------------
function getRankMultiplier(rank) {
  return RANK_MULTIPLIERS[rank] || 1.0; // fallback to 1.0 if unknown rank
}

function computeTeamValue({rank, epa, win_prob}) {
  // Normalized EPA factor (so an EPA of 10 => factor ~1)
  const epaFactor = Math.max(0.01, epa / SCALE_EPA);

  // Rank multiplier
  const rankMul = getRankMultiplier(rank);

  // Lower win probability => higher value. We invert win_prob, but add EPS.
  const winFactor = 1 / (win_prob + EPS);

  const rawValue = epaFactor * rankMul * winFactor;

  // Enforce minimum
  const value = Math.max(MIN_TEAM_VALUE, rawValue);

  return {
    rawValue,
    value,
    components: {epaFactor, rankMul, winFactor}
  };
}

function computeAllianceValue(teamObjs) {
  // teamObjs: array of {team_key, rank, epa, win_prob}
  const teams = teamObjs.map(t => ({...t, computed: computeTeamValue(t)}));
  const allianceValue = teams.reduce((s, t) => s + t.computed.value, 0);
  const allianceEPA = teams.reduce((s, t) => s + (t.epa || 0), 0);
  return {teams, allianceValue, allianceEPA};
}

// Suggest an over/under line for the match based on combined EPA and alliance values.
function suggestOverUnder(redAlliance, blueAlliance) {
  // Base line: mean of expected alliance EPAs (rounded to 1 decimal)
  const baseLine = Math.round(((redAlliance.allianceEPA + blueAlliance.allianceEPA) / 2) * 10) / 10;

  // Adjust line using relative alliance values: the higher the value, the higher the "implied payout".
  // We'll compute an adjustment factor from allianceValue ratio.
  const totalValue = redAlliance.allianceValue + blueAlliance.allianceValue;
  const redShare = redAlliance.allianceValue / (totalValue || 1);
  const blueShare = blueAlliance.allianceValue / (totalValue || 1);

  // If an alliance has much higher value, make the line slightly lower (favorites expected to score more?)
  // Here we craft a simple, tunable rule: delta = (share - 0.5) * 0.2 * baseLine
  const redDelta = (redShare - 0.5) * 0.2 * baseLine;
  const blueDelta = (blueShare - 0.5) * 0.2 * baseLine;

  const redLine = Math.round((baseLine + redDelta) * 10) / 10;
  const blueLine = Math.round((baseLine + blueDelta) * 10) / 10;

  // For betting, we provide a single match line: average of redLine and blueLine
  const matchLine = Math.round(((redLine + blueLine) / 2) * 10) / 10;

  // Build implied odds: higher alliance value -> smaller payout (example mapping)
  // We'll compute a crude payout multiplier for each alliance: payout = 1 + (1 - (value/avgValue))
  const avgValue = (redAlliance.allianceValue + blueAlliance.allianceValue) / 2 || 1;
  const redPayout = Math.max(1.01, 1 + (1 - (redAlliance.allianceValue / avgValue)) * 0.5);
  const bluePayout = Math.max(1.01, 1 + (1 - (blueAlliance.allianceValue / avgValue)) * 0.5);

  return {
    baseLine,
    matchLine,
    perAlliance: {
      red: {line: redLine, allianceValue: redAlliance.allianceValue, payoutMultiplier: Math.round(redPayout*100)/100},
      blue: {line: blueLine, allianceValue: blueAlliance.allianceValue, payoutMultiplier: Math.round(bluePayout*100)/100}
    }
  };
}

// ------------------ API ------------------
app.get('/health', (req, res) => {
  res.json({status: 'ok', now: new Date().toISOString()});
});

// POST /predict
// Body example:
// {
//  "match_id": "qm1",
//  "alliances": {
//    "red": [ {team_key:"frc254", rank:1, epa:40, win_prob:0.75}, ... ],
//    "blue": [ ... ]
//  }
// }
app.post('/predict', (req, res) => {
  try {
    const {match_id, alliances} = req.body;
    if (!alliances || !alliances.red || !alliances.blue) return res.status(400).json({error: 'alliances.red and alliances.blue required'});

    const red = computeAllianceValue(alliances.red);
    const blue = computeAllianceValue(alliances.blue);

    const suggestion = suggestOverUnder(red, blue);

    res.json({match_id, red, blue, suggestion});
  } catch (err) {
    console.error(err);
    res.status(500).json({error: String(err)});
  }
});

// POST /bet
// Body: {user, match_id, alliance: 'red'|'blue', amount, type: 'over'|'under', line}
app.post('/bet', (req, res) => {
  const {user, match_id, alliance, amount, type, line} = req.body;
  if (!user || !match_id || !alliance || !amount || !type) return res.status(400).json({error: 'missing fields'});
  const id = bets.length + 1;
  const bet = {id, user, match_id, alliance, amount, type, line, time: new Date().toISOString()};
  bets.push(bet);
  res.json({status: 'ok', bet});
});

app.get('/bets', (req, res) => {
  res.json({count: bets.length, bets});
});

// Simple simulate endpoint to demonstrate
app.post('/simulate', (req, res) => {
  // Accept body: {n} number of random matches to simulate
  const n = parseInt(req.body.n || 10);
  const results = [];
  for (let i=0;i<n;i++){
    // make 3-team alliances with random ranks, epa, win_prob
    function randTeam(idx){
      const rank = Math.floor(Math.random()*8)+1;
      const epa = Math.round((Math.random()*60 - 10) * 10)/10; // EPA between -10 and 50
      const win_prob = Math.round(Math.random()*100)/100; // 0..1
      return {team_key:`frc${1000+idx}`, rank, epa, win_prob};
    }
    const redTeams = [randTeam(i*3), randTeam(i*3+1), randTeam(i*3+2)];
    const blueTeams = [randTeam(i*3+3), randTeam(i*3+4), randTeam(i*3+5)];
    const red = computeAllianceValue(redTeams);
    const blue = computeAllianceValue(blueTeams);
    const suggestion = suggestOverUnder(red, blue);
    results.push({match:`sim${i+1}`, red, blue, suggestion});
  }
  res.json({results});
});

app.listen(PORT, () => {
  console.log(`Statbotics betting prototype running on http://localhost:${PORT} (pid ${process.pid})`);
});

/*
=== Example request (curl) ===

curl -X POST http://localhost:3000/predict -H "Content-Type: application/json" -d '\
{ 
  "match_id":"qm1",
  "alliances":{
    "red":[{"team_key":"frc254","rank":1,"epa":38.5,"win_prob":0.78},{"team_key":"frc1678","rank":3,"epa":28.4,"win_prob":0.62},{"team_key":"frc971","rank":5,"epa":15.2,"win_prob":0.43}],
    "blue":[{"team_key":"frc1114","rank":2,"epa":34.1,"win_prob":0.73},{"team_key":"frc2056","rank":4,"epa":26.0,"win_prob":0.59},{"team_key":"frc148","rank":6,"epa":14.9,"win_prob":0.41}]
  }
}\'

Response will contain alliance values, team component breakdowns, and an over/under suggestion.

=== Next steps / optional improvements ===
1. Replace in-memory bets with a database (Postgres, SQLite) and add user authentication.
2. Hook to Statbotics API or The Blue Alliance to fetch live EPA/rank/win predictions.
3. Add a frontend (React/Vite) showing matches, odds, and accept wagers.
4. Implement real odds calculation and house edge, with liability management.
5. Add unit tests and tuning pipeline to calibrate SCALE_EPA and payout formulas using historical data.
6. Make this a true GitHub App by using Probot: respond to issues/PRs or create actions that update match lines.

If you want, I can:
- Turn this into a GitHub repository scaffold (package.json, README.md, Dockerfile, GitHub Action),
- Add a simple React UI to pick alliances and place bets,
- Wire it up to Statbotics / The Blue Alliance using their APIs (I'd need API keys).

Tell me which of the above you'd like next and I'll scaffold the files and instructions.
*/
