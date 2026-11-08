# -*- coding: utf-8 -*-
"""用 git cat-file --batch 补齐工作区缺失的图片文件（绕过 checkout 的索引/stat 逻辑）"""
import subprocess, os, sys, time

REPO = r"D:/other/gong/tiku/repo"
SUBTREE = sys.argv[1] if len(sys.argv) > 1 else "90-图片"
os.chdir(REPO)

def ls_tree(path):
    out = subprocess.run(["git", "ls-tree", "-r", "-z", "HEAD", "--", path],
                         capture_output=True, check=True).stdout
    items = []
    for rec in out.split(b'\0'):
        if not rec:
            continue
        meta, p = rec.split(b'\t', 1)
        mode, typ, sha = meta.split(b' ')
        items.append((p.decode('utf-8'), sha.decode()))
    return items

items = ls_tree(SUBTREE)
print("树内文件:", len(items))

missing = [(p, s) for p, s in items if not os.path.exists(p)]
print("缺失:", len(missing))
if not missing:
    sys.exit(0)

t0 = time.time()
proc = subprocess.Popen(["git", "cat-file", "--batch"], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
done = 0
for p, sha in missing:
    proc.stdin.write((sha + "\n").encode())
    proc.stdin.flush()
    header = proc.stdout.readline().split()
    if len(header) < 3:
        print("异常:", p, header); continue
    size = int(header[2])
    data = proc.stdout.read(size)
    proc.stdout.read(1)  # 结尾换行
    d = os.path.dirname(p)
    if d:
        os.makedirs(d, exist_ok=True)
    with open(p, "wb") as f:
        f.write(data)
    done += 1
    if done % 500 == 0:
        el = time.time() - t0
        print(f"  {done}/{len(missing)}  {el:.0f}s  {done/el:.0f} 个/秒", flush=True)
proc.stdin.close()
proc.wait()
print(f"完成 {done} 个，用时 {time.time()-t0:.0f}s")
