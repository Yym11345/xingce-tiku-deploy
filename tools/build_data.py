# -*- coding: utf-8 -*-
"""
行测真题库 -> 结构化站点数据构建脚本
输入: repo/0X-模块/*.md
输出: site/data/*.json
"""
import os, re, json, hashlib, collections, sys, time

ROOT = r"D:/other/gong/tiku/repo"
OUT = r"D:/other/gong/tiku/site/data"
MODS = [
    ("01", "政治理论"),
    ("02", "常识判断"),
    ("03", "言语理解与表达"),
    ("04", "数量关系"),
    ("05", "判断推理"),
    ("06", "资料分析"),
]
SHARD = 600

QHDR = re.compile(r'^#{2,3}\s*第\s*(\d+)\s*题\s*<sub>\s*qid\s*(\d+)\s*·\s*([^<]*?)\s*</sub>')
MAT = re.compile(r'^##\s*材料\s*(\d+)\s*$')
OPT = re.compile(r'^-\s*\*\*([A-H])\*\*[\.．]\s*(.*)$')
ANS = re.compile(r'^\*\*答案\*\*\s*[：:]\s*(.*)$')

def norm_ws(s):
    return re.sub(r'\s+', ' ', s).strip()

def fix_imgs(s):
    s = s.replace('src="../90-图片/', 'src="90-图片/')
    s = s.replace("src='../90-图片/", "src='90-图片/")
    return s

# ---------------- 考点 / 问法 推断规则 ----------------
def opt_is_idiom(t):
    t = re.sub(r'[^\u4e00-\u9fa5]', '', t or '')
    return len(t) == 4

YANYU_ASKS = [
    ("细节判断", ["符合文意", "不符合文意", "与原文相符", "与原文不符", "可以推出", "无法推出",
                "理解正确", "理解不正确", "说法正确", "说法错误", "表述正确", "表述错误",
                "与文意相符", "与文意不符", "没有提及", "未提及", "正确的一项是", "不正确的一项是",
                "错误的一项是", "推断正确", "推断错误", "理解错误", "理解有误", "不相符"]),
    ("标题填入", ["标题", "命名最恰当"]),
    ("下文推断", ["接下来", "下文", "随后", "作为文章的引言"]),
    ("词句理解", ["加点词语", "划线部分", "划横线部分", "指的是", "含义是", "意思是",
                "具体内涵", "内涵是", "指的是什么"]),
    ("态度观点", ["态度", "作者认为", "观点"]),
    ("中心理解", ["主要说明", "主要介绍", "主要强调", "主要讲述", "主要论述", "主要谈论",
                "意在说明", "意在强调", "意在表明", "主旨", "概括最准确", "主要观点",
                "中心意思", "复述最准确", "主要意思", "核心观点", "想要说明", "意在指出",
                "这段文字主要", "这段文字旨在", "最准确的是"]),
]

YUJU_ASKS = [
    ("语句排序", ["重新排列", "语序", "顺序最恰当", "排列组合最连贯", "排序", "最恰当的一项是"]),
    ("语句填空", ["填入", "横线", "划横线"]),
    ("接语选择", ["接下来", "下文"]),
]

LUOJI_ASKS = [
    ("削弱质疑", ["最能削弱", "削弱上述", "削弱该", "最能反驳", "反驳上述", "质疑"]),
    ("加强支持", ["最能加强", "加强上述", "支持上述", "加强该", "支持该", "最能支持"]),
    ("前提假设", ["前提", "假设", "必需", "必要条件"]),
    ("原因解释", ["最能解释", "解释上述", "原因"]),
    ("真假推理", ["说真话", "真假", "只有一个"]),
    ("结论推出", ["由此可以推出", "可以推出", "不能推出", "由此可知", "结论是"]),
    ("评价论证", ["评价", "论证方式", "逻辑错误", "相似"]),
]

SL_KEY = [
    ("工程问题", ["工程", "效率", "工期", "合作完成", "注水", "水管", "队合作"]),
    ("行程问题", ["速度", "千米/小时", "公里/小时", "相遇", "追及", "顺水", "逆水", "列车", "往返", "步行", "骑车", "影子"]),
    ("经济利润", ["利润", "成本", "售价", "进价", "打折", "折扣", "盈利", "亏损", "定价", "标价"]),
    ("排列组合", ["多少种", "排法", "选法", "安排", "组合", "排列", "不同方式", "方案数", "合照", "单人照"]),
    ("概率问题", ["概率", "可能性"]),
    ("几何问题", ["面积", "周长", "体积", "半径", "直径", "立方体", "圆柱", "三角形", "正方形",
                "长方形", "圆锥", "球", "梯形", "边长", "角度", "表面积", "路灯"]),
    ("年龄问题", ["年龄"]),
    ("浓度问题", ["浓度", "溶液", "盐水", "酒精", "糖水"]),
    ("容斥原理", ["既", "都不", "至少有一", "只参加", "都参加"]),
    ("最值问题", ["至少", "最多", "最少", "至多", "最大", "最小"]),
    ("周期问题", ["周期", "循环", "每隔"]),
    ("日期星期", ["星期", "闰年", "日期", "几月几日"]),
    ("数列问题", ["数列", "等差", "等比", "第几项"]),
    ("和差倍比", ["之比", "比例为", "的比", "倍", "百分位", "中位数", "平均数", "平均"]),
    ("计算问题", ["计算", "尾数", "整除", "倍数特征", "余数", "平方", "立方"]),
]

def pick(rules, text, default):
    best, bestn = None, 0
    for name, kws in rules:
        n = sum(text.count(k) for k in kws)
        if n > bestn:
            best, bestn = name, n
    return best or default

def infer_kp(mod_code, subtype, stem, opts, exp):
    """返回 (考点, 来源)  来源: official / rule / none"""
    body = stem + " " + (exp or "")
    tail = stem[-160:]

    if mod_code == "06":  # 资料分析: 官方解析最可靠
        m = re.search(r'判定本题为(.{2,20}?)问题', exp or '')
        if m:
            return m.group(1).strip(), 'official'
        m = re.search(r'判定本题为(.{2,20}?)问题', body)
        if m:
            return m.group(1).strip(), 'official'
        if re.search(r'[A-D]项[：:]', exp or '') or re.search(r'[①②③④].*[①②③④]', stem):
            return "综合分析（逐项验证）", 'rule'
        return "数据查找与简单计算", "rule"

    if mod_code == "04":
        return pick(SL_KEY, stem, "其他数学运算"), 'rule'

    if mod_code == "03":
        if subtype == "逻辑填空":
            n = sum(1 for o in opts if opt_is_idiom(o))
            if n == 0:
                return "实词辨析", 'rule'
            if n == len(opts):
                return "成语辨析", 'rule'
            return "实词与成语综合辨析", 'rule'
        if subtype == "片段阅读":
            for name, kws in YANYU_ASKS:
                if any(k in tail for k in kws):
                    return name, 'rule'
            for name, kws in YANYU_ASKS:
                if any(k in stem for k in kws):
                    return name, 'rule'
            return "片段阅读其他", 'rule'
        if subtype == "语句表达":
            for name, kws in YUJU_ASKS:
                if any(k in stem for k in kws):
                    return name, 'rule'
            return "语句表达其他", 'rule'
        return subtype, 'none'

    if mod_code == "05":
        if subtype == "逻辑判断":
            for name, kws in LUOJI_ASKS:
                if any(k in tail for k in kws):
                    return name, 'rule'
            for name, kws in LUOJI_ASKS:
                if any(k in stem for k in kws):
                    return name, 'rule'
            return "逻辑判断其他", 'rule'
        if subtype == "图形推理":
            m = re.search(r'(空间重构|平面拼合|立体拼合|三视图|截面图|六面体)', exp or '')
            if m:
                return m.group(1), 'official'
            return "图形规律", 'rule'
        return subtype, 'none'

    # 01 政治理论 / 02 常识判断: 题型本身即考点
    return subtype, 'none'

# ---------------- 解析单文件 ----------------
def parse_file(path, mod_code, mod_name):
    raw = open(path, encoding='utf-8').read()
    fm = {}
    body = raw
    if raw.startswith('---'):
        end = raw.find('\n---', 3)
        if end > 0:
            head = raw[3:end]
            body = raw[end + 4:]
            for line in head.splitlines():
                if ':' in line:
                    k, v = line.split(':', 1)
                    fm[k.strip()] = v.strip().strip('"')
    lines = body.splitlines()

    # 切成 段: ("mat", idx, lines) / ("q", headerline, lines)
    blocks = []
    cur = None
    for ln in lines:
        mm = MAT.match(ln)
        if mm:
            cur = ['mat', int(mm.group(1)), []]
            blocks.append(cur)
            continue
        mq = QHDR.match(ln)
        if mq:
            cur = ['q', (int(mq.group(1)), int(mq.group(2)), mq.group(3)), []]
            blocks.append(cur)
            continue
        if ln.startswith('# ') or ln.startswith('> '):
            continue
        if ln.strip() == '---':
            continue
        if cur is not None:
            cur[2].append(ln)

    materials = []
    qs = []
    gid = -1
    for kind, meta, ls in blocks:
        if kind == 'mat':
            txt = '\n'.join(ls).strip()
            txt = re.sub(r'\n{3,}', '\n\n', txt)
            materials.append(fix_imgs(txt))
            gid = len(materials) - 1
            continue
        no, qid, subtype = meta
        stem_lines, opts, ans, exp_lines = [], [], '', []
        stage = 0
        for ln in ls:
            ma = ANS.match(ln.strip())
            if ma:
                ans = ma.group(1).strip()
                stage = 2
                continue
            if ln.strip() in ('**官方解析**', '**解析**', '**答案解析**'):
                stage = 2
                continue
            mo = OPT.match(ln)
            if mo and stage <= 1:
                opts.append((mo.group(1), fix_imgs(mo.group(2).strip())))
                stage = 1
                continue
            if stage == 0:
                stem_lines.append(ln)
            elif stage == 2:
                exp_lines.append(ln)
        stem = '\n'.join(stem_lines).strip()
        stem = re.sub(r'(?m)^-\s*（选项）\s*\[\s*\]\s*$', '', stem)
        exp = '\n'.join(exp_lines).strip()
        stem = re.sub(r'\n{3,}', '\n\n', fix_imgs(stem))
        exp = re.sub(r'\n{3,}', '\n\n', fix_imgs(exp))

        # 选项清洗: 去掉 ✅ 标记
        marked = None
        clean = []
        for k, v in opts:
            if '✅' in v:
                marked = k
            v = v.replace('✅', '').strip()
            v = re.sub(r'\s*　$', '', v).strip()
            clean.append(v)
        letters = [k for k, _ in opts]
        a = (ans or marked or '').replace(' ', '').upper()
        a = re.sub(r'[^A-H]', '', a)
        if not a and marked:
            a = marked
        # 判断题: 源数据无选项, 答案为 A/B, 解析含"表述正确/错误"
        if not clean:
            m_exp = re.search(r'故?表述(正确|错误)|该说法(正确|错误)|故(正确|错误)', exp)
            if m_exp:
                clean = ['正确', '错误']
                letters = ['A', 'B']
                if not a:
                    a = 'A' if '正确' in m_exp.group(0) else 'B'
                elif a not in ('A', 'B'):
                    a = 'B'
        qs.append({
            'id': qid, 'no': no, 't': subtype,
            's': stem, 'o': clean, 'L': letters, 'a': a,
            'e': exp, 'g': gid if materials else -1,
        })
    return fm, materials, qs

# ---------------- 主流程 ----------------
def main():
    os.makedirs(OUT, exist_ok=True)
    os.makedirs(os.path.join(OUT, 'qs'), exist_ok=True)

    papers = {}          # title -> dict
    all_q = []           # 全局顺序题目
    all_mat = {}         # paperIdx -> [materials]

    for mod_code, mod_name in MODS:
        d = os.path.join(ROOT, f"{mod_code}-{mod_name}")
        files = sorted(f for f in os.listdir(d) if f.endswith('.md') and f != 'README.md')
        for fn in files:
            fm, mats, qs = parse_file(os.path.join(d, fn), mod_code, mod_name)
            title = fm.get('试卷') or fn[:-3]
            year = fm.get('年份') or ''
            region = fm.get('地区') or ''
            p = papers.get(title)
            if p is None:
                p = {'t': title, 'y': year, 'r': region, 'm': {}}
                papers[title] = p
            start = len(all_q)
            for q in qs:
                q['p'] = title
                q['m'] = mod_code
                all_q.append(q)
            p['m'][mod_code] = [start, len(qs)]
            if mats:
                # 材料按 (卷, 模块) 存
                all_mat.setdefault(title, {})[mod_code] = mats

    # 排序: 年份倒序 -> 卷名
    order = sorted(papers.values(), key=lambda p: (-int(p['y'] or 0), p['t']))
    pidx = {p['t']: i for i, p in enumerate(order)}
    # 重排题目为 卷序 -> 模块序
    mod_order = {c: i for i, (c, _) in enumerate(MODS)}
    newq = []
    pstart = {}
    for i, p in enumerate(order):
        mods = sorted(p['m'].items(), key=lambda kv: mod_order[kv[0]])
        pstart[p['t']] = {}
        for code, (st, n) in mods:
            pstart[p['t']][code] = [len(newq), n]
            newq.extend(all_q[st:st + n])
    all_q = newq

    # 题目 -> 精简字段 + 去重 hash
    out = []
    for i, q in enumerate(all_q):
        h = hashlib.md5((norm_ws(q['s']) + '|' + '|'.join(norm_ws(o) for o in q['o'])).encode()).hexdigest()[:10]
        out.append({
            'i': i, 'id': q['id'], 'p': pidx[q['p']], 'm': q['m'], 't': q['t'],
            'k': q.get('k', ''), 'ks': q.get('ks', ''),
            's': q['s'], 'o': q['o'], 'L': q['L'], 'a': q['a'], 'e': q['e'],
            'g': q['g'], 'h': h,
        })

    # 考点推断
    for q in out:
        kp, src = infer_kp(q['m'], q['t'], q['s'], q['o'], q['e'])
        q['k'] = kp
        q['ks'] = src

    # 去重标记
    seen = {}
    for q in out:
        if q['h'] in seen:
            q['d'] = 1
            seen[q['h']].append(q['i'])
        else:
            q['d'] = 0
            seen[q['h']] = [q['i']]

    # 写分片
    nshard = (len(out) + SHARD - 1) // SHARD
    for k in range(nshard):
        chunk = out[k * SHARD:(k + 1) * SHARD]
        with open(os.path.join(OUT, 'qs', f'{k}.json'), 'w', encoding='utf-8') as f:
            json.dump(chunk, f, ensure_ascii=False, separators=(',', ':'))

    # papers.json
    pj = []
    for i, p in enumerate(order):
        pj.append({
            'i': i, 't': p['t'], 'y': int(p['y'] or 0), 'r': p['r'],
            'm': {c: pstart[p['t']][c] for c in p['m']},
            'n': sum(n for _, n in p['m'].values()),
        })
    json.dump({'papers': pj, 'shard': SHARD}, open(os.path.join(OUT, 'papers.json'), 'w', encoding='utf-8'),
              ensure_ascii=False, separators=(',', ':'))

    # 材料
    matj = {}
    for title, mods in all_mat.items():
        matj[str(pidx[title])] = mods
    json.dump(matj, open(os.path.join(OUT, 'mat.json'), 'w', encoding='utf-8'),
              ensure_ascii=False, separators=(',', ':'))

    # 索引 & 桶
    qids = sorted(q['id'] for q in out)
    id2loc = {q['id']: q['i'] for q in out}
    locs = [id2loc[x] for x in qids]
    buckets = {'mod': {}, 'sub': {}, 'kp': {}, 'year': {}, 'region': {}, 'paper': {}}
    for q in out:
        loc = q['i']
        buckets['mod'].setdefault(q['m'], []).append(loc)
        buckets['sub'].setdefault(q['m'] + '|' + q['t'], []).append(loc)
        if q['k']:
            buckets['kp'].setdefault(q['m'] + '|' + q['k'], []).append(loc)
        buckets['year'].setdefault(str(pj[q['p']]['y']), []).append(loc)
        buckets['region'].setdefault(pj[q['p']]['r'], []).append(loc)
    buckets['uniq'] = [q['i'] for q in out if not q['d']]
    json.dump({'qids': qids, 'locs': locs, 'shard': SHARD},
              open(os.path.join(OUT, 'index.json'), 'w', encoding='utf-8'),
              ensure_ascii=False, separators=(',', ':'))
    json.dump(buckets, open(os.path.join(OUT, 'buckets.json'), 'w', encoding='utf-8'),
              ensure_ascii=False, separators=(',', ':'))

    # meta: 统计
    sub_stat = collections.Counter()
    kp_stat = collections.Counter()
    kp_sub = collections.defaultdict(collections.Counter)
    year_stat = collections.Counter()
    reg_stat = collections.Counter()
    mod_stat = collections.Counter()
    dup = sum(1 for q in out if q['d'])
    img = sum(1 for q in out if '<img' in q['s'] or '<img' in q['e'])
    for q in out:
        sub_stat[q['m'] + '|' + q['t']] += 1
        kp_stat[q['m'] + '|' + q['k']] += 1
        kp_sub[q['m'] + '|' + q['k']][q['t']] += 1
        year_stat[str(pj[q['p']]['y'])] += 1
        reg_stat[pj[q['p']]['r']] += 1
        mod_stat[q['m']] += 1
    meta = {
        'total': len(out), 'papers': len(pj), 'dup': dup, 'img': img,
        'mods': [{'c': c, 'n': n, 'q': mod_stat[c]} for c, n in MODS],
        'subs': [{'m': k.split('|')[0], 't': k.split('|')[1], 'n': v} for k, v in sub_stat.most_common()],
        'kps': [{'m': k.split('|')[0], 'k': k.split('|')[1], 'n': v,
                 't': kp_sub[k].most_common(1)[0][0]} for k, v in kp_stat.most_common()],
        'years': sorted([{'y': int(k), 'n': v} for k, v in year_stat.items() if k != '0'], key=lambda x: x['y']),
        'regions': [{'r': k, 'n': v} for k, v in reg_stat.most_common()],
        'built': time.strftime('%Y-%m-%d %H:%M'),
    }
    json.dump(meta, open(os.path.join(OUT, 'meta.json'), 'w', encoding='utf-8'),
              ensure_ascii=False, separators=(',', ':'))

    print('题目', len(out), '卷', len(pj), '分片', nshard, '材料卷', len(matj))
    print('重复题', dup, f'({dup/len(out)*100:.1f}%)', '含图题', img)
    print('考点去重', len(kp_stat), '题型', len(sub_stat))
    for f in sorted(os.listdir(OUT)):
        fp = os.path.join(OUT, f)
        if os.path.isfile(fp):
            print(f'  {f}: {os.path.getsize(fp)/1024:.0f} KB')

if __name__ == '__main__':
    main()
