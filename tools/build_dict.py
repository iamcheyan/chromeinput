#!/usr/bin/env python3
"""chromeinput 词库构建脚本 (GOAL.md §二).

基础词库: 朙月拼音 luna_pinyin.dict.yaml -> extension/dicts/base.json
用户资产: sbzr.userdb/shortcut/zdy 三个 YAML, 双拼码反解为全拼 -> extension/dicts/user.json

输出格式: [[word, "pin yin", weight], ...]  (音节以空格分隔; weight int)

用法:
    python3 tools/build_dict.py [--luna /tmp/luna.dict.yaml] [--audit-only]
"""
import argparse
import json
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = Path('~/development/rime-study/sbzr.chrome.extension')
DB_TSV = Path('~/development/rime-study/resource/常用字双拼拼音.db')
LUNA_URL = ('https://raw.githubusercontent.com/rime/rime-luna-pinyin/'
            'master/luna_pinyin.dict.yaml')  # 注意分支是 master
SIZE_BUDGET = 2.5 * 1024 * 1024

# 权重基值 (对齐源仓 reweight_dicts.py 习惯, GOAL §二)
CHAR_BASE = 50014          # 无权重单字
PHRASE_BASE = 1000         # 无权重词组 (字数不放大: 候选排序已有"字数短优先")
USER_WEIGHT = 999999       # 用户资产置顶

# ---------------------------------------------------------------- 双拼映射
# 声笔自然 (自然码变体): zh->z ch->c sh->s 合并, 零声母 v (声笔自然编码规则.md)
INITIALS = ['zh', 'ch', 'sh', 'b', 'p', 'm', 'f', 'd', 't', 'n', 'l', 'g',
            'k', 'h', 'j', 'q', 'x', 'r', 'z', 'c', 's', 'y', 'w']
FINAL_KEYS = {
    'iu': 'q', 'ia': 'w', 'ua': 'w', 'e': 'e', 'er': 'r', 'uan': 'r',
    'ue': 't', 've': 't', 'uai': 'y', 'ing': 'y', 'u': 'u', 'i': 'i',
    'uo': 'o', 'o': 'o', 'un': 'p', 'a': 'a', 'ong': 's', 'iong': 's',
    'iang': 'd', 'uang': 'd', 'en': 'f', 'eng': 'g', 'ang': 'h', 'an': 'j',
    'ao': 'k', 'ai': 'l', 'ei': 'z', 'ie': 'x', 'iao': 'c', 'ui': 'v',
    'v': 'v', 'ou': 'b', 'in': 'n', 'ian': 'm',
}
KEY_FINALS = {}  # key -> [finals...] (长韵母优先)


def _build_key_finals():
    for final, key in FINAL_KEYS.items():
        KEY_FINALS.setdefault(key, []).append(final)
    for k in KEY_FINALS:
        KEY_FINALS[k].sort(key=len, reverse=True)


_build_key_finals()


def encode_syllable(syl: str) -> str:
    """全拼音节 -> 双拼两码 (正向, 用于互验)."""
    for ini in INITIALS:
        if syl.startswith(ini) and len(syl) > len(ini):
            final = syl[len(ini):]
            if final in FINAL_KEYS:
                ini_key = {'zh': 'z', 'ch': 'c', 'sh': 's'}.get(ini, ini)
                return ini_key + FINAL_KEYS[final]
    if syl == 'er':
        return 'vr'
    if syl in FINAL_KEYS:  # 零声母: e/er/a/ai...
        return 'v' + FINAL_KEYS[syl]
    if syl in ('n', 'ng', 'hm', 'hng', 'ê', 'ei0'):
        return None
    return None


def decode_syllable(code2: str):
    """双拼两码 -> 全拼音节候选列表 (逆向, 可能歧义)."""
    if len(code2) != 2:
        return None
    s, y = code2
    if s == 'v':  # 零声母
        if y == 'r':
            return ['er']
        return KEY_FINALS.get(y, [])
    if s == 'y':
        # y + 韵母键: ü 规范为 u (yu/yue)
        return ['y' + f.replace('v', 'u') for f in KEY_FINALS.get(y, [])]
    if s == 'w':
        return ['w' + f for f in KEY_FINALS.get(y, [])]
    if s in ('z', 'c', 's'):
        ini = {'z': ['z', 'zh'], 'c': ['c', 'ch'], 's': ['s', 'sh']}[s]
        out = []
        for i in ini:
            out.extend(i + f for f in KEY_FINALS.get(y, []))
        return out
    if s in FINAL_KEYS or s in ('b', 'p', 'm', 'f', 'd', 't', 'n', 'l',
                                'g', 'k', 'h', 'j', 'q', 'x', 'r'):
        return [s + f for f in KEY_FINALS.get(y, [])]
    return None


# ---------------------------------------------------------------- 朙月词库
def load_luna(path: Path):
    text = path.read_text(encoding='utf-8')
    lines = text.split('\n')
    body = lines[lines.index('...') + 1:] if '...' in lines else lines
    entries = []
    for line in body:
        if not line.strip():
            continue
        cols = line.split('\t')
        cols = [c for c in cols if c != '']
        if len(cols) < 2:
            continue
        word, pinyin = cols[0], cols[1]
        weight = None
        if len(cols) >= 3 and cols[2].endswith('%'):
            weight = round(float(cols[2][:-1]) * 1000)
        elif len(cols) >= 3 and cols[2].isdigit():
            weight = int(cols[2])
        entries.append((word, pinyin, weight))
    return entries


def base_weight(word: str, orig) -> int:
    if orig is not None:
        return orig
    n = len(word)
    if n == 1:
        return CHAR_BASE
    return PHRASE_BASE

def load_essay(path: Path):
    """rime-essay 预设词汇 (word\\tweight, 无拼音) -> [(word, weight)]"""
    out = []
    if not path.exists():
        return out
    for line in path.read_text(encoding='utf-8').split('\n'):
        cols = line.split('\t')
        if len(cols) == 2 and cols[1].isdigit() and 2 <= len(cols[0]) <= 8:
            out.append((cols[0], int(cols[1])))
    return out


def load_opencc_t2s(phrase_path: Path, char_path: Path):
    """OpenCC 繁->简: 词组表优先, 单字表回退 (一对多取第一映射)."""
    def parse(path):
        table = {}
        if not path.exists():
            return table
        for line in path.read_text(encoding='utf-8').split('\n'):
            if not line or line.startswith('#'):
                continue
            parts = line.split('\t')
            if len(parts) >= 2 and parts[1]:
                table[parts[0]] = parts[1].split(' ')[0]
        return table
    return parse(phrase_path), parse(char_path)


def t2s(word, phrases, chars):
    if word in phrases:
        return phrases[word]
    out = []
    for ch in word:
        out.append(chars.get(ch, ch))
    return ''.join(out)

def rank_luna_singles(luna):
    """单字读音按 luna % 权重排序 -> {char: [pinyin...]}"""
    raw = {}
    for word, pinyin, w in luna:
        if len(word) == 1 and ' ' not in pinyin:
            raw.setdefault(word, []).append((pinyin, w or 0))
    return {ch: [p for p, _ in sorted(v, key=lambda x: -x[1])]
            for ch, v in raw.items()}


def annotate_essay(essay, singles, db):
    """essay 词条逐字注音 (luna 首选读音, 缺字回退 db 反解)."""
    fallback_cache = {}

    def reading(ch):
        lst = singles.get(ch)
        if lst:
            return lst[0]
        if ch not in fallback_cache:
            cands = []
            for code, _ in db.get(ch, [])[:2]:
                cands.extend(decode_syllable(code) or [])
            fallback_cache[ch] = cands[0] if cands else None
        return fallback_cache[ch]

    out = []
    for word, weight in essay:
        syls = []
        for ch in word:
            r = reading(ch)
            if r is None:
                syls = None
                break
            syls.append(r)
        if syls:
            out.append((word, ' '.join(syls), weight))
    return out


# ---------------------------------------------------------------- 字音库
def load_char_db():
    """常用字双拼拼音.db (实为 TSV: 字\\t双拼\\t频次) -> {char: [(code,wt)]}"""
    db = {}
    for line in DB_TSV.read_text(encoding='utf-8').split('\n'):
        parts = line.split('\t')
        if len(parts) == 3 and parts[1]:
            db.setdefault(parts[0], []).append((parts[1], int(parts[2])))
    for ch in db:
        db[ch].sort(key=lambda x: -x[1])
    return db


def char_readings(ch, db, luna_singles):
    """字的候选全拼读音: luna 全拼读音优先, 与 db 双拼码互验."""
    cands = []
    for pinyin in luna_singles.get(ch, []):
        cands.append(pinyin)
    if not cands:  # luna 没有, 从 db 反解 (可能歧义, 列出全部)
        top = db.get(ch, [])
        for code, _ in top[:2]:
            cands.extend(decode_syllable(code) or [])
    return cands


def convert_word(word, db, luna_singles, overrides):
    """逐字取音 -> 全拼串. 返回 (pinyin_list, per_char, missing)."""
    syls, per, missing = [], [], []
    for ch in word:
        if not ('\u3400' <= ch <= '\u9fff' or '\uf900' <= ch <= '\ufaff'):
            continue  # 标点等不参与注音
        if ch in overrides:
            syls.append(overrides[ch])
            per.append(f'{ch}={overrides[ch]}(override)')
            continue
        cands = char_readings(ch, db, luna_singles)
        db_top = db.get(ch, [])
        chosen = None
        if cands:
            if db_top:
                top_code = db_top[0][0]
                for c in cands:
                    if encode_syllable(c) == top_code:
                        chosen = c
                        break
            chosen = chosen or cands[0]
        if chosen is None:
            missing.append(ch)
            per.append(f'{ch}=?')
        else:
            syls.append(chosen)
            per.append(f'{ch}={chosen}')
    return syls, per, missing


# ---------------------------------------------------------------- 用户资产
def parse_rime_yaml(path: Path):
    lines = path.read_text(encoding='utf-8').split('\n')
    start = lines.index('...') + 1 if '...' in lines else 0
    out = []
    for line in lines[start:]:
        cols = [c for c in line.split('\t') if c != '']
        if len(cols) >= 2:
            out.append((cols[0], cols[1], int(cols[2]) if len(cols) > 2
                        and cols[2].isdigit() else None))
    return out


CJK = re.compile(r'^[\u3400-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]+$')


def build_user_entries(db, luna_singles, overrides):
    entries, audit = [], []
    sources = [
        ('sbzr.userdb.dict.yaml', None),
        ('sbzr.shortcut.dict.yaml', None),
        ('zdy.dict.yaml', None),
    ]
    for name, _ in sources:
        for word, code, _w in parse_rime_yaml(SRC / 'dicts' / name):
            row = {'src': name.split('.')[0], 'word': word, 'code': code}
            if CJK.match(word):
                syls, per, missing = convert_word(
                    word, db, luna_singles, overrides)
                if missing:
                    row['note'] = f'缺字音: {"".join(missing)} -> 保留原码'
                    entries.append([word, code, USER_WEIGHT])
                else:
                    full = ' '.join(syls)
                    key = full.replace(' ', '')
                    entries.append([word, full, USER_WEIGHT])
                    if code and code != key and re.match(r'^[a-z]+$', code):
                        entries.append([word, code, USER_WEIGHT])
                        row['note'] = '全拼+原码双键'
                    else:
                        row['note'] = '全拼'
                row['pinyin'] = ' '.join(syls)
                row['per_char'] = ' '.join(per)
            else:
                entries.append([word, code, USER_WEIGHT])
                row['note'] = '非纯中文 -> 原码保留'
            audit.append(row)
    return entries, audit


# ---------------------------------------------------------------- 主流程
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--luna', default='/tmp/luna.dict.yaml')
    ap.add_argument('--essay', default='/tmp/essay.txt')
    ap.add_argument('--audit-only', action='store_true')
    args = ap.parse_args()

    luna_path = Path(args.luna)
    if not luna_path.exists():
        print(f'luna 词库不存在, 从 {LUNA_URL} 下载...')
        urllib.request.urlretrieve(LUNA_URL, luna_path)

    luna = load_luna(luna_path)
    luna_singles = rank_luna_singles(luna)
    essay = load_essay(Path(args.essay))
    phrases_t2s, chars_t2s = load_opencc_t2s(
        Path('/tmp/ts_phrases.txt'), Path('/tmp/ts_chars.txt'))

    db = load_char_db()
    overrides = {  # 人工核对修订 (audit 输出与词义核对)
        '行': 'xing',   # 苦行僧 kuxingseng (db 首选 hang 不合词义)
        '单': 'dan',    # 简单 jandan (db 首选 chan 不合词义)
        '无': 'wu',     # 无意义 wu (db 首选 mo 为"南无"读音, 不合词义)
    }

    user_entries, audit = build_user_entries(db, luna_singles, overrides)

    if args.audit_only:
        for row in audit:
            print(f"{row['src']}\t{row['word']}\t{row['code']}\t"
                  f"{row.get('pinyin', '-')}\t{row['note']}\t"
                  f"{row.get('per_char', '')}")
        return

    # 基础词库: luna 全量 + essay 预设词汇 (word 去重, luna 优先)
    merged = {}
    order = []
    for i, (word, pinyin, w) in enumerate(luna):
        word = t2s(word, phrases_t2s, chars_t2s)
        luna[i] = (word, pinyin, w)
        k = (word, pinyin)
        if k not in merged:
            merged[k] = base_weight(word, w)
            order.append(k)
        else:
            merged[k] = max(merged[k], base_weight(word, w))
    luna_words = {w for w, _p, _wt in luna}
    essay_ann = annotate_essay(essay, luna_singles, db)
    for word, pinyin, w in essay_ann:
        word = t2s(word, phrases_t2s, chars_t2s)
        if word in luna_words:
            continue
        k = (word, pinyin)
        if k not in merged:
            merged[k] = w
            order.append(k)
    base = [[w, p, merged[(w, p)]] for (w, p) in order]

    # 用户资产去重
    seen, user = set(), []
    for word, code, w in user_entries:
        if (word, code) in seen:
            continue
        seen.add((word, code))
        user.append([word, code, w])

    # 体积预算: 超限则按权重截断词组 (单字全保留); 按 UTF-8 字节计 (中文 3B/字)
    def dump(obj):
        return json.dumps(obj, ensure_ascii=False, separators=(',', ':'))

    def size(obj):
        return len(dump(obj).encode('utf-8'))

    total = size(base) + size(user)
    if total > SIZE_BUDGET:
        chars = [e for e in base if len(e[0]) == 1]
        phrases = sorted((e for e in base if len(e[0]) > 1),
                         key=lambda e: -e[2])
        keep = SIZE_BUDGET - size(user) - size(chars) - 2048
        buf, kept = [], 0
        for e in phrases:
            line = size([e]) + 1
            if kept + line > keep:
                break
            kept += line
            buf.append(e)
        print(f'超预算, 词组截断: {len(buf)}/{len(phrases)}', file=sys.stderr)
        base = chars + buf
        total = size(base) + size(user)


    out_dir = ROOT / 'extension' / 'dicts'

    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / 'base.json').write_text(dump(base), encoding='utf-8')
    (out_dir / 'user.json').write_text(dump(user), encoding='utf-8')
    print(f'base.json: {len(base)} 条')
    print(f'user.json: {len(user)} 条')
    print(f'合计: {total / 1024 / 1024:.2f} MB (预算 2.5MB)')


if __name__ == '__main__':
    main()
