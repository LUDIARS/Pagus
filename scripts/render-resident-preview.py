"""Rasterize the exact production triangles for an offline review sheet."""
import json, math, sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

out = Path(sys.argv[1])
models = json.loads((out / 'resident-meshes.json').read_text(encoding='utf-8'))
scale = 2
im = Image.new('RGB', (1680*scale, 820*scale), '#eee6d7')
draw = ImageDraw.Draw(im)
fontpath = 'C:/Windows/Fonts/meiryo.ttc'
font = lambda size: ImageFont.truetype(fontpath, size*scale)
def text(x,y,s,size=18,fill='#493d38'):
    draw.text((x*scale,y*scale),s,font=font(size),fill=fill)
text(45,22,'PAGUS  /  住民の3Dモデル比較',30)
text(45,68,'上：教育前　　下：同じ住民に教育由来のパーツが混ざった姿',19)
text(45,101,'実装中のメッシュを使用した静止画。ゲーム画面のスクリーンショットではありません。',14)
def render(vertices,cx,cy):
    tris=[]
    for j in range(0,len(vertices),18):
        points=[vertices[j+k:j+k+3] for k in (0,6,12)]
        a,b,c=points
        u=[b[i]-a[i] for i in range(3)]; v=[c[i]-a[i] for i in range(3)]
        n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]]
        length=math.sqrt(sum(q*q for q in n)) or 1
        light=.5+.5*abs(sum(n[i]*(-.4,.8,.5)[i] for i in range(3))/length/math.sqrt(1.05))
        color=tuple(min(255,max(0,round(q*light*255))) for q in vertices[j+3:j+6])
        coords=[]; depth=0
        for x,y,z in points:
            xx=math.cos(-.2)*x-math.sin(-.2)*z; zz=math.sin(-.2)*x+math.cos(-.2)*z
            coords.append(((cx+xx*112)*scale,(cy-(y*.866-zz*.5)*112)*scale)); depth+=zz*.866+y*.5
        tris.append((depth,coords,color))
    draw.ellipse(((cx-48)*scale,(cy-12)*scale,(cx+48)*scale,(cy+12)*scale),fill='#d5ccbc')
    for _,coords,color in sorted(tris,key=lambda t:t[0]): draw.polygon(coords,fill=color)
labels={'tentacles':'触手','eyes':'第三の目','teapot':'ティーポット','clockwork':'ぜんまい','cthulhu':'深淵の触手','slime':'スライム化','extraArms':'4本腕','hybrid':'頭が別の動物'}
for i,m in enumerate(models):
    x=125+i*238
    text(x-16,155,m['species'],22)
    render(m['normal'],x,390)
    render(m['mixed'],x,700)
    text(x-70,736,'＋'.join(labels[p] for p in m['parts']),15)
text(45,788,'種は維持。混合パーツ・優先行動・抑制ゲートは、同じ教育履歴から決まります。',14)
im.resize((1680,820),Image.Resampling.LANCZOS).save(out/'resident-comparison.png')
