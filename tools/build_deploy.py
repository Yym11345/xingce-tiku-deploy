# -*- coding: utf-8 -*-
"""构建线上版：deploy/
- 题目图 png/jpg -> 无损/高质量 WebP
- 公式图原样复制
- data/*.json 复制并改写图片路径
- 附带支持 gzip + PORT 环境的 server.py
"""
import os, re, io, sys, json, shutil, time
from concurrent.futures import ProcessPoolExecutor

ROOT = r"D:/other/gong/tiku"
SRC = os.path.join(ROOT, "site")
REPO = os.path.join(ROOT, "repo")
OUT = os.path.join(ROOT, "deploy")

BASE_IMG = os.path.join(REPO, "90-图片")
IMG_SRC = os.path.join(BASE_IMG, "题目图")
IMG_OUT = os.path.join(OUT, "90-图片", "题目图")
GZ_SRC = os.path.join(BASE_IMG, "公式图")
GZ_OUT = os.path.join(OUT, "90-图片", "公式图")
CONV = ('.png', '.jpg', '.jpeg', '.jfif')


def conv_one(rel):
    src = os.path.join(IMG_SRC, rel)
    dst = os.path.join(IMG_OUT, os.path.splitext(rel)[0] + '.webp')
    try:
        from PIL import Image
        im = Image.open(src)
        ext = os.path.splitext(rel)[1].lower()
        if getattr(im, 'is_animated', False):
            return rel, 'skip-anim'
        if ext == '.png':
            im = im.convert('RGBA') if im.mode in ('RGBA', 'LA', 'P') else im.convert('RGB')
            im.save(dst, 'WEBP', lossless=True, quality=100, method=4)
        else:
            im = im.convert('RGB')
            im.save(dst, 'WEBP', quality=88, method=4)
        return rel, os.path.getsize(src)
    except Exception as e:
        return rel, 'ERR:' + str(e)[:40]


def main():
    t0 = time.time()
    fast = '--fast' in sys.argv          # 只更新前端与数据，跳过图片转换

    if not fast and os.path.isdir(OUT):
        shutil.rmtree(OUT)
    os.makedirs(IMG_OUT, exist_ok=True)
    os.makedirs(GZ_OUT, exist_ok=True)

    if fast:
        print('快速模式：跳过图片转换')
        # 清掉本地测试产生的账号库，避免把测试用户带上线
        shutil.rmtree(os.path.join(OUT, '.data'), ignore_errors=True)
        shutil.copytree(os.path.join(SRC, 'assets'), os.path.join(OUT, 'assets'), dirs_exist_ok=True)
        shutil.copy2(os.path.join(SRC, 'index.html'), os.path.join(OUT, 'index.html'))
        shutil.copy2(os.path.join(ROOT, 'tools', 'deploy_server.py'), os.path.join(OUT, 'server.py'))
        tot = 0; cnt = 0
        for r, _, fs in os.walk(OUT):
            for f in fs:
                tot += os.path.getsize(os.path.join(r, f)); cnt += 1
        print(f'完成：{tot/1048576:.0f} MB / {cnt} 文件，用时 {time.time()-t0:.0f}s')
        return

    # 1. 题目图 -> webp
    names = [f for f in os.listdir(IMG_SRC)
             if os.path.splitext(f)[1].lower() in CONV]
    print(f'题目图待转 {len(names)} 张')
    ok = 0; bad = []; orig = 0
    with ProcessPoolExecutor(max_workers=8) as ex:
        for i, (rel, r) in enumerate(ex.map(conv_one, names, chunksize=40), 1):
            if isinstance(r, str):
                bad.append((rel, r))
            else:
                ok += 1; orig += r
            if i % 1000 == 0:
                print(f'  {i}/{len(names)}  {time.time()-t0:.0f}s', flush=True)
    new = sum(os.path.getsize(os.path.join(IMG_OUT, f)) for f in os.listdir(IMG_OUT))
    for b in bad[:5]:
        print('   !', b)
    if orig:
        print(f'  完成 {ok} 张，失败 {len(bad)}；{orig/1048576:.1f}MB -> {new/1048576:.1f}MB ({new/orig*100:.0f}%)')
    else:
        print(f'  完成 {ok} 张，失败 {len(bad)}')

    # 2. 非转换格式（gif）原样复制
    for f in os.listdir(IMG_SRC):
        if os.path.splitext(f)[1].lower() not in CONV:
            shutil.copy2(os.path.join(IMG_SRC, f), os.path.join(IMG_OUT, f))

    # 3. 公式图原样复制
    print('复制公式图…', flush=True)
    n = 0
    for f in os.listdir(GZ_SRC):
        shutil.copy2(os.path.join(GZ_SRC, f), os.path.join(GZ_OUT, f))
        n += 1
    print(f'  {n} 张')

    # 4. 静态资源
    shutil.copytree(os.path.join(SRC, 'assets'), os.path.join(OUT, 'assets'))
    shutil.copy2(os.path.join(SRC, 'index.html'), os.path.join(OUT, 'index.html'))

    # 5. 数据：复制 + 改写图片路径
    print('复制并改写数据…', flush=True)
    os.makedirs(os.path.join(OUT, 'data', 'qs'), exist_ok=True)
    RX = re.compile(r'(90-图片/题目图/[0-9A-Za-z_\-]+)\.(?:png|jpg|jpeg|jfif)')
    for fn in os.listdir(os.path.join(SRC, 'data')):
        p = os.path.join(SRC, 'data', fn)
        if os.path.isfile(p):
            if fn.endswith('.json'):
                s = open(p, encoding='utf-8').read()
                s = RX.sub(r'\1.webp', s)
                open(os.path.join(OUT, 'data', fn), 'w', encoding='utf-8').write(s)
            else:
                shutil.copy2(p, os.path.join(OUT, 'data', fn))
    for fn in os.listdir(os.path.join(SRC, 'data', 'qs')):
        p = os.path.join(SRC, 'data', 'qs', fn)
        s = open(p, encoding='utf-8').read()
        s = RX.sub(r'\1.webp', s)
        open(os.path.join(OUT, 'data', 'qs', fn), 'w', encoding='utf-8').write(s)

    # 6. 服务端
    shutil.copy2(os.path.join(ROOT, 'tools', 'deploy_server.py'), os.path.join(OUT, 'server.py'))
    open(os.path.join(OUT, 'requirements.txt'), 'w').write('')

    tot = 0; cnt = 0
    for r, _, fs in os.walk(OUT):
        for f in fs:
            tot += os.path.getsize(os.path.join(r, f)); cnt += 1
    print(f'\n完成：{tot/1048576:.0f} MB / {cnt} 文件，用时 {time.time()-t0:.0f}s')


if __name__ == '__main__':
    main()
