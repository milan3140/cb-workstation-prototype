# -*- coding: utf-8 -*-
"""產生完全合成的 demo 資料,讓前端零憑證、零後端就能跑起來。

用法:
    py data-service/scripts/make_demo_data.py            # 寫進 web/public/
    py data-service/scripts/make_demo_data.py <輸出目錄>

產出(檔名與路徑=前端 dataSource.js 的靜態退路契約):
    raw.json            總覽快照:today + raw(15-tuple)+ derived/cbBasic/credit/exDiv/borrow
    history.json        近 60 日收盤走勢(列上 sparkline)
    kline/<現股>.json    現股 K 線:60分/日/週/月
    cb_kline/<CB>.json   可轉債自身 K 線:日(20 根)/週/月
    cb_custody.json     月集保庫存異動(24 月)
    cb_legal.json       三大法人買賣(逐日 20 筆)
    cb_terms.json       轉換期間/票面利率/上市日/到期日

資料全部由固定亂數種子產生 → 每次跑結果相同(可重現、可進版控)。
沒有任何真實公司、真實價格或外部來源;示範標的一律以「示範」命名、代號 9xxx。

設計上刻意覆蓋各條分支,讓原型每一頁都有東西可看:
  · 6 檔命中型態訊號 A~F(精選頁 chip 每個都有料)
  · 若干檔 parity 貼近 100(發動/精選門檻 |parity−100| ≤ 5)
  · 1 檔交換公司債(EB:CB 代號前綴 ≠ 換股標的代號),驗發行人/標的分離邏輯
  · 1 檔停止轉換期間內(stopNow=true)、1 檔強贖觸發中、信用燈綠/黃/紅各有
"""
import json
import os
import random
import sys
from datetime import datetime, timedelta

SEED = 20260828
random.seed(SEED)

OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'web', 'public')

PATTERNS = ['型態A', '型態B', '型態C', '型態D', '型態E', '型態F']

# (現股代號, 現股名, 產業別隨機種子偏移)
ISSUERS = [
    ('9001', '示範水泥'), ('9002', '示範電子'), ('9003', '示範生技'),
    ('9004', '示範航運'), ('9005', '示範食品'), ('9006', '示範紡織'),
    ('9007', '示範營建'), ('9008', '示範金屬'), ('9009', '示範軟體'),
    ('9010', '示範能源'), ('9011', '示範光電'), ('9012', '示範通路'),
]
CN = {1: '一', 2: '二', 3: '三'}

TODAY = datetime.now()
TODAY_STR = TODAY.strftime('%Y%m%d')


def ymd(d):
    return d.strftime('%Y%m%d')


def walk(n, start, vol=0.02, drift=0.0):
    """隨機漫步收盤序列(合成價格,非真實行情)。"""
    out, px = [], start
    for _ in range(n):
        px = max(1.0, px * (1 + random.gauss(drift, vol)))
        out.append(round(px, 2))
    return out


def bars(closes, start_dt, step_days, with_turnover=False):
    """收盤序列 → OHLCV 陣列(timestamp 為 UTC 毫秒)。"""
    out = []
    for i, c in enumerate(closes):
        d = start_dt + timedelta(days=i * step_days)
        o = round(c * (1 + random.gauss(0, .006)), 2)
        hi = round(max(o, c) * (1 + abs(random.gauss(0, .008))), 2)
        lo = round(min(o, c) * (1 - abs(random.gauss(0, .008))), 2)
        vol = float(random.randint(300, 40000))
        bar = {'timestamp': int(d.replace(hour=0, minute=0, second=0, microsecond=0).timestamp() * 1000),
               'open': o, 'high': hi, 'low': lo, 'close': c, 'volume': vol}
        if with_turnover:
            bar['turnover'] = round(vol * c * 1000, 0)
        out.append(bar)
    return out


def main():
    # ── 現股價:**一檔現股只有一個價**(先定股價,再回推各 CB 的轉換價)。
    # 反過來做(先隨機轉換價、再由 parity 回推股價)會讓同一檔現股底下的多檔 CB
    # 各自得到不同的現股價 —— 清單群組表頭、K 線最後一根、明細三處會互相矛盾。
    stock_px = {stk: round(random.uniform(15, 120), 2) for stk, _ in ISSUERS}

    cbs = []          # 每檔 CB 的完整設定
    # ── 標的宇宙:每家 1~2 檔 CB,前 8 家的第一檔配一個型態訊號 ──
    for idx, (stk, name) in enumerate(ISSUERS):
        n_cb = 1 if idx % 3 == 2 else 2
        for j in range(1, n_cb + 1):
            has_pattern = j == 1 and idx < 8
            near = idx < 8 or has_pattern        # 前 8 家與所有帶型態者:現股貼近轉換價
            parity = random.uniform(97, 103) if near else random.choice(
                [random.uniform(62, 88), random.uniform(108, 145)])
            stk_px = stock_px[stk]
            conv_px = round(stk_px * 100 / parity, 2)   # 由股價與目標平價回推
            cbs.append({
                'code': f'{stk}{j}', 'name': f'{name}{CN[j]}', 'stkCode': stk, 'stk': name,
                'convPx': conv_px, 'stkPx': stk_px,
                'pattern': PATTERNS[idx % 6] if has_pattern else None,
                'isEB': False,
            })
    # ── 交換公司債(EB):代號前綴 9013 = 發行公司,換股標的 = 示範食品 9005。
    # 用來走通「發行人 ≠ 標的股」的分支;現股價沿用 9005 的唯一價格。
    eb_stk = '9005'
    cbs.append({
        'code': '90131', 'name': '示範控股E1', 'stkCode': eb_stk, 'stk': dict(ISSUERS)[eb_stk],
        'convPx': round(stock_px[eb_stk] * 100 / random.uniform(97, 103), 2),
        'stkPx': stock_px[eb_stk], 'pattern': '型態B', 'isEB': True,
    })

    raw, derived, cb_basic, credit, ex_div, borrow = [], {}, {}, {}, {}, {}
    custody, legal, terms, history = {}, {}, {}, {}
    kline_dir = os.path.join(OUT, 'kline')
    cbk_dir = os.path.join(OUT, 'cb_kline')
    os.makedirs(kline_dir, exist_ok=True)
    os.makedirs(cbk_dir, exist_ok=True)

    for i, c in enumerate(cbs):
        code, stk_px, conv_px = c['code'], c['stkPx'], c['convPx']
        parity = 100 / conv_px * stk_px
        # CB 價:偏股者跟著平價、偏債者黏在面額附近
        cb_px = round(max(parity * random.uniform(.98, 1.12), random.uniform(96, 104)), 2)
        put_dt = TODAY + timedelta(days=random.randint(120, 1300))
        put_px = round(random.choice([100.0, 101.0, 102.0, 103.0]), 2)
        # 有型態訊號的標的一律讓籌碼與熱度也過門檻,精選頁(型態 + |parity−100|≤5 + 未轉換>50)
        # 才會有足夠內容;沒型態的維持隨機分佈,讓篩選器看得出差別。
        if c['pattern']:
            unconv = round(random.uniform(56, 96), 1)
            heat = round(random.uniform(4.5, 9.5), 1)
        else:
            unconv = round(random.choice([random.uniform(52, 100), random.uniform(8, 48)]), 1)
            heat = round(random.choice([random.uniform(4, 9.5), random.uniform(-2, 3.5)]), 1)
        guar = random.choice(['有擔保', '無', '無', '有擔保'])
        vol = random.randint(0, 4200)

        # ── 15-tuple(契約見 DATA_SCHEMA.md)──
        raw.append([code, c['name'], c['stkCode'], c['stk'], stk_px, conv_px, cb_px, vol,
                    1 if random.random() < .12 else 0, put_dt.strftime('%Y/%m/%d'), put_px,
                    guar, unconv, heat, c['pattern']])

        yrs_to_put = max(0.0, (put_dt - TODAY).days / 365.25)
        conv_val = round(parity, 4)
        dev = round((cb_px - conv_val) / conv_val * 100, 4) if conv_val else None
        put_ret = round((put_px - cb_px) / cb_px * 100, 4)
        nature = '偏股型' if parity >= 100 else ('股債平衡' if parity >= 80 else '偏債型')
        mat_dt = put_dt + timedelta(days=random.randint(180, 900))
        stopping = i == 3                              # 刻意留一檔停止轉換中
        derived[code] = {
            'convVal': conv_val, 'dev': dev, 'putRet': put_ret,
            'statusWord': '停止轉換中' if stopping else ('可轉換' if parity >= 100 else '未達轉換價'),
            'statusTone': 'warn' if stopping else ('up' if parity >= 100 else 'dim'),
            'yrsToPut': round(yrs_to_put, 4), 'parity': conv_val, 'prem': dev,
            'nature': nature,
            'putYtm': round((put_px / cb_px) ** (1 / max(yrs_to_put, .1)) * 100 - 100, 4),
            'ytm': round(random.uniform(-1.5, 4.5), 4),
            'matDate': ymd(mat_dt),
            'prospectus': 'https://docs.example.com/prospectus/%s.pdf' % code,
        }
        cb_basic[code] = {
            'coupon': 0.0, 'matPrice': 100.0, 'matYtm': 0.0, 'issuePrice': 100.0,
            'issuedAmt': float(random.randint(2, 30) * 1000),
            'latestBal': float(random.randint(1, 25) * 1000),
            'issueConvPx': round(conv_px * random.uniform(.9, 1.15), 2),
            'issuePremium': round(random.uniform(100.5, 112), 2),
            'guar': guar, 'rating': '', 'isin': f'DEMO{code}00',
            'convStart': ymd(TODAY - timedelta(days=random.randint(200, 900))),
            'convEnd': ymd(mat_dt),
            # 強贖條款:130% 連續 30 日(第 5 檔刻意設成觸發中)
            'callTrigger1': 130.0, 'callDays1': 30.0,
            'stopConvStart': ymd(TODAY - timedelta(days=5)) if stopping else '',
            'stopConvEnd': ymd(TODAY + timedelta(days=25)) if stopping else '',
        }
        if i == 5:
            cb_basic[code]['callTrigger1'] = 100.0     # 觸價 = 轉換價 → 現股已達 → 觸發中
        # 信用:綠/黃/紅三種體質都有
        tier = i % 3
        credit[code] = {
            'credScore': [2, 5, 8][tier], 'finRating': [3, 6, 8][tier],
            'debtRatio': round(random.uniform(28, 72), 2),
            'quickRatio': round(random.uniform(60, 210), 2),
            'interestCover': round(random.uniform(.8, 9.5), 2),
            'zScore': [3.4, 2.1, 1.2][tier],
        }
        if random.random() < .3:
            ex_div[code] = {'exDivDate': ymd(TODAY + timedelta(days=random.randint(5, 60))),
                            'exRightDate': ymd(TODAY + timedelta(days=random.randint(5, 60)))}
        borrow[code] = {'borrowBal': float(random.randint(0, 12000))}

        # 集保庫存異動(24 月)
        issued = cb_basic[code]['issuedAmt']
        cust, bal = [], issued
        for m in range(24):
            d = TODAY - timedelta(days=(23 - m) * 30)
            chg = round(bal * random.uniform(-.06, .02), 0)
            bal = max(0.0, bal + chg)
            cust.append({'ym': d.strftime('%Y%m'), 'custodyLots': bal, 'changeLots': chg,
                         'issuedLots': issued,
                         'custodyPct': round(bal / issued * 100, 2) if issued else 0.0,
                         'holders': float(random.randint(30, 400))})
        custody[code] = cust
        # 三大法人(逐日 20 筆)
        legal[code] = [{'date': ymd(TODAY - timedelta(days=19 - k)),
                        'foreign': float(random.randint(-40, 40)),
                        'trust': float(random.randint(-10, 10)),
                        'dealer': float(random.randint(-60, 60)),
                        'total': 0.0} for k in range(20)]
        for row in legal[code]:
            row['total'] = row['foreign'] + row['trust'] + row['dealer']
        terms[code] = {
            'convFrom': cb_basic[code]['convStart'], 'convTo': cb_basic[code]['convEnd'],
            'coupon': 0.0, 'listedOn': cb_basic[code]['convStart'],
            'delistedOn': '', 'maturity': ymd(mat_dt),
        }

        # CB 自身 K 線:日 20 根(上游深度限制)/週 106 /月 26
        cb_closes_d = walk(20, cb_px * .96)
        cb_doc = {
            'schemaVersion': 1, 'symbol': code, 'isCb': True,
            'updatedAt': int(TODAY.timestamp() * 1000),
            'periods': {
                'day': bars(cb_closes_d, TODAY - timedelta(days=20), 1),
                'week': bars(walk(106, cb_px * .8), TODAY - timedelta(weeks=106), 7),
                'month': bars(walk(26, cb_px * .75), TODAY - timedelta(days=26 * 30), 30),
            },
        }
        json.dump(cb_doc, open(os.path.join(cbk_dir, f'{code}.json'), 'w', encoding='utf-8'),
                  ensure_ascii=False, separators=(',', ':'))

    # ── 現股 K 線 + 60 日走勢(以現股代號為鍵,EB 的換股標的已含在 ISSUERS)──
    for stk, name in ISSUERS:
        base = stock_px[stk]                             # 與總覽同一個價(見上面的註解)
        closes_d = walk(250, base * .85, drift=.0008)
        closes_d[-1] = base                              # 最後一根對齊總覽現股價
        doc = {
            'schemaVersion': 1, 'symbol': stk,
            'updatedAt': int(TODAY.timestamp() * 1000),
            'periods': {
                'day': bars(closes_d, TODAY - timedelta(days=250), 1, with_turnover=True),
                'week': bars(walk(106, base * .7), TODAY - timedelta(weeks=106), 7, True),
                'month': bars(walk(26, base * .6), TODAY - timedelta(days=26 * 30), 30, True),
                # 60分 K(選配週期;上游對冷門標的可能沒有 → 原型保留這個分支)
                'hour': bars(walk(300, base * .97), TODAY - timedelta(days=45), 1, True),
            },
        }
        json.dump(doc, open(os.path.join(kline_dir, f'{stk}.json'), 'w', encoding='utf-8'),
                  ensure_ascii=False, separators=(',', ':'))
        hist = closes_d[-60:]
        history[stk] = {'d0': ymd(TODAY - timedelta(days=60)), 'd1': TODAY_STR, 'c': hist}

    snapshot = {'today': TODAY_STR, 'raw': raw, 'derived': derived, 'cbBasic': cb_basic,
                'credit': credit, 'exDiv': ex_div, 'borrow': borrow}
    for fname, payload in [('raw.json', snapshot), ('history.json', history),
                           ('cb_custody.json', custody), ('cb_legal.json', legal),
                           ('cb_terms.json', terms)]:
        with open(os.path.join(OUT, fname), 'w', encoding='utf-8') as fh:
            json.dump(payload, fh, ensure_ascii=False, separators=(',', ':'))

    pat_hits = sum(1 for r in raw if r[14])
    near = sum(1 for c in cbs if abs(100 / c['convPx'] * c['stkPx'] - 100) <= 5)
    # 純 ASCII 標記:Windows 主控台(cp950)不吃 ✓ 之類的符號,會在最後一行炸掉
    print(f'[OK] demo 資料寫入 {OUT}')
    print(f'  標的 {len(cbs)} 檔(含 1 檔 EB)/ 現股 {len(ISSUERS)} 檔')
    print(f'  型態訊號命中 {pat_hits} 檔 / 貼近轉換價(±5%) {near} 檔 / 資料日 {TODAY_STR}')


if __name__ == '__main__':
    main()
