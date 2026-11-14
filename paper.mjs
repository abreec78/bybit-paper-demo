import { readFileSync, writeFileSync } from 'node:fs';

const step = 900000;
const week = 604800000;
const start = 30;
const cost = 0.00085;
const symbol = 'BTCUSDT';
const current = Math.floor(Date.now() / step) * step;
const file = process.argv[2] ?? 'journal.json';
let state;
try {
    state = JSON.parse(readFileSync(file, 'utf8'));
} catch (error) {
    if (error.code !== 'ENOENT') throw error;
    state = { last: current - 2 * step, close: [], accounts: [1, 3, 5].map(leverage => ({
        leverage, balance: start, week: null, weekStart: start, position: null,
    })), events: [] };
}

async function marketPage(end) {
    const url = new URL('https://api.bybit.com/v5/market/kline');
    url.search = new URLSearchParams({
        category: 'linear', symbol, interval: '15', limit: '1000', end,
    });
    const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error('Bybit HTTP ' + response.status);
    const data = await response.json();
    if (data.retCode !== 0 || !data.result?.list?.length) throw new Error(data.retMsg || 'Empty response');
    return data.result.list;
}

const from = state.close.length ? state.last + step : state.last - 20 * step;
const candles = new Map();
let end = current - 1;
while (end >= from) {
    const page = await marketPage(end);
    const oldest = Number(page.at(-1)[0]);
    if (oldest > end) throw new Error('Invalid pagination');
    for (const [time, open, , , close] of page) {
        if (+time >= from && +time < current) candles.set(+time, { open: +open, close: +close });
    }
    end = oldest - 1;
}
for (let time = from; time < current; time += step) {
    const bar = candles.get(time);
    if (!bar || !(bar.open > 0 && bar.close > 0)) throw new Error('Missing candle ' + new Date(time).toISOString());
    const recent = state.close;
    if (time > state.last) {
        const last = recent.at(-1);
        const previous = recent.slice(0, -1);
        const side = last > Math.max(...previous) ? 1 : last < Math.min(...previous) ? -1 : 0;
        for (const account of state.accounts) {
            const period = Math.floor((time + 3 * 86400000) / week);
            if (account.week !== period) {
                account.week = period;
                account.weekStart = account.balance;
            }
            const pos = account.position;
            if (pos) {
                const ratio = bar.open / pos.price;
                const fees = pos.value * cost * (1 + ratio);
                const pnl = Math.max(-account.balance, pos.value * pos.side * (ratio - 1) - fees);
                account.balance += pnl;
                state.events.push({ time, leverage: account.leverage, action: 'close', price: bar.open, fees, pnl, balance: account.balance });
                account.position = null;
            }
            if (side && account.balance > 0 && account.weekStart - account.balance < start * 0.05) {
                const value = account.balance * 0.2 * account.leverage;
                account.position = { side, price: bar.open, value };
                state.events.push({ time, leverage: account.leverage, action: 'open', ...account.position });
            }
        }
        state.last = time;
    }
    recent.push(bar.close);
    if (recent.length > 21) recent.shift();
}
writeFileSync(file, JSON.stringify(state, null, 2) + '\n');
console.table(state.accounts.map(({ leverage, balance, position }) => ({
    leverage, balanceUSDT: balance.toFixed(2), position: position?.side ?? 0,
})));
console.log('Last candle:', new Date(state.last).toISOString(), 'Events:', state.events.length);
