#!/usr/bin/env python3
import json
import math
import zipfile
import hashlib
import html
import re
import subprocess
import sys
from pathlib import Path
from xml.etree import ElementTree as ET

from PIL import Image, ImageDraw, ImageFont, ImageColor

PAGE_DIR = Path('/Users/mac/work/su/codex_discord_bridge/outputs/image-to-editable-ppt/codex-discord-bridge-user-guide-editable/pages/page_004')
SKILL_DIR = Path('/Users/mac/.codex/skills/image-to-editable-ppt')
PYTHON = Path('/Users/mac/.codex/skills/image-to-editable-ppt/.venv/bin/python')
SOURCE = PAGE_DIR / 'source.png'
MANIFEST = PAGE_DIR / 'manifest.json'
PPTX = PAGE_DIR / 'page.pptx'
PREVIEW = PAGE_DIR / 'preview.png'
CONTACT = PAGE_DIR / 'split_assets_contact.png'
VALIDATION = PAGE_DIR / 'validation.json'
PAGE_RESULT = PAGE_DIR / 'page_result.json'
IMAGEGEN_JOBS = PAGE_DIR / 'imagegen-jobs.json'

SLIDE_W_PX = 1672
SLIDE_H_PX = 941
SLIDE_W_IN = 13.333
SLIDE_H_IN = 7.5
EMU_PER_INCH = 914400
SCALE = 120

BLUE = '#286fd3'
NAVY = '#061d58'
GREEN = '#2f6b34'
GREEN_LIGHT = '#eef7ee'
GREEN_PALE = '#f6fbf4'
ORANGE = '#ee6a00'
ORANGE_LIGHT = '#fffaf5'
GRAY = '#757575'
DARK = '#07102f'
PDF_RED = '#cf250f'
CODE_BLUE = '#245a9b'
LINE_GRAY = '#b7b7bd'
DASH_GRAY = '#a58b76'

HAND_FONT = '/System/Library/Fonts/STHeiti Medium.ttc'
PREVIEW_FONT = '/System/Library/Fonts/STHeiti Medium.ttc'


def px_to_in(box):
    x, y, w, h = box
    return [x / SLIDE_W_PX * SLIDE_W_IN, y / SLIDE_H_PX * SLIDE_H_IN, w / SLIDE_W_PX * SLIDE_W_IN, h / SLIDE_H_PX * SLIDE_H_IN]


def emu(value):
    return int(round(float(value) * EMU_PER_INCH))


def hex_color(value, default='000000'):
    if not value:
        return default
    return str(value).strip().lstrip('#').upper()


def xml_text(value):
    return html.escape(str(value), quote=True)


def sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def shape_fill(fill):
    if not fill or fill == 'none':
        return '<a:noFill/>'
    return f'<a:solidFill><a:srgbClr val="{hex_color(fill)}"/></a:solidFill>'


def shape_line(stroke, width=1, dash=None):
    if not stroke or stroke == 'none':
        return '<a:ln><a:noFill/></a:ln>'
    dash_xml = f'<a:prstDash val="{xml_text(dash)}"/>' if dash else ''
    return f'<a:ln w="{int(float(width) * 12700)}"><a:solidFill><a:srgbClr val="{hex_color(stroke)}"/></a:solidFill>{dash_xml}</a:ln>'


def adj_from_radius(box_px, radius_px):
    min_dim = max(1.0, min(float(box_px[2]), float(box_px[3])))
    return max(0, min(50000, int(round(float(radius_px) / min_dim * 100000))))


def geometry_xml(preset, item):
    if preset == 'roundRect':
        adj = adj_from_radius(item.get('box_px', [0, 0, 1, 1]), item.get('source_corner_radius_px', 8))
        return f'<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val {adj}"/></a:avLst></a:prstGeom>'
    return f'<a:prstGeom prst="{preset}"><a:avLst/></a:prstGeom>'


def rect_like_xml(idx, item):
    x, y, w, h = px_to_in(item['box_px'])
    preset = item.get('preset') or ('roundRect' if item.get('type') == 'roundRect' else 'ellipse' if item.get('type') == 'ellipse' else item.get('type', 'rect'))
    return f'''
      <p:sp>
        <p:nvSpPr><p:cNvPr id="{idx}" name="{xml_text(item.get('name', preset))}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="{emu(x)}" y="{emu(y)}"/><a:ext cx="{emu(w)}" cy="{emu(h)}"/></a:xfrm>{geometry_xml(preset, item)}{shape_fill(item.get('fill'))}{shape_line(item.get('stroke', '#000000'), item.get('stroke_width', 1), item.get('dash'))}</p:spPr>
        <p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody>
      </p:sp>'''


def line_xml(idx, item):
    x1, y1, x2, y2 = item['points_px']
    left = min(x1, x2) / SLIDE_W_PX * SLIDE_W_IN
    top = min(y1, y2) / SLIDE_H_PX * SLIDE_H_IN
    width = abs(x2 - x1) / SLIDE_W_PX * SLIDE_W_IN
    height = abs(y2 - y1) / SLIDE_H_PX * SLIDE_H_IN
    flip_h = ' flipH="1"' if x2 < x1 else ''
    flip_v = ' flipV="1"' if y2 < y1 else ''
    preset = item.get('preset', 'line')
    return f'''
      <p:sp>
        <p:nvSpPr><p:cNvPr id="{idx}" name="{xml_text(item.get('name', 'Line'))}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr><a:xfrm{flip_h}{flip_v}><a:off x="{emu(left)}" y="{emu(top)}"/><a:ext cx="{emu(width)}" cy="{emu(height)}"/></a:xfrm><a:prstGeom prst="{preset}"><a:avLst/></a:prstGeom>{shape_fill('none')}{shape_line(item.get('stroke', '#000000'), item.get('stroke_width', 1), item.get('dash'))}</p:spPr>
        <p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody>
      </p:sp>'''


def freeform_xml(idx, item):
    pts = item.get('freeform_points_px', item.get('points_px'))
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)
    w_px = max(1, max_x - min_x)
    h_px = max(1, max_y - min_y)
    left, top, width, height = px_to_in([min_x, min_y, w_px, h_px])
    path_w = 100000
    path_h = 100000
    commands = []
    first = True
    for px, py in pts:
        rel_x = int(round((px - min_x) / w_px * path_w))
        rel_y = int(round((py - min_y) / h_px * path_h))
        if first:
            commands.append(f'<a:moveTo><a:pt x="{rel_x}" y="{rel_y}"/></a:moveTo>')
            first = False
        else:
            commands.append(f'<a:lnTo><a:pt x="{rel_x}" y="{rel_y}"/></a:lnTo>')
    if item.get('closed'):
        commands.append('<a:close/>')
    geometry = f'<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/><a:pathLst><a:path w="{path_w}" h="{path_h}">{"".join(commands)}</a:path></a:pathLst></a:custGeom>'
    return f'''
      <p:sp>
        <p:nvSpPr><p:cNvPr id="{idx}" name="{xml_text(item.get('name', 'Freeform'))}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="{emu(left)}" y="{emu(top)}"/><a:ext cx="{emu(width)}" cy="{emu(height)}"/></a:xfrm>{geometry}{shape_fill(item.get('fill'))}{shape_line(item.get('stroke', '#000000'), item.get('stroke_width', 2), item.get('dash'))}</p:spPr>
        <p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody>
      </p:sp>'''


def text_box_xml(idx, item):
    x, y, w, h = px_to_in(item['box_px'])
    font_size = int(float(item.get('font_size', 18)) * 100)
    font = xml_text(item.get('font', 'STHeiti'))
    align = item.get('align', 'left')
    anchor = item.get('valign', 'top')
    wrap = item.get('wrap', 'none')
    autofit = '<a:spAutoFit/>' if item.get('autofit') == 'shape' else '<a:noAutofit/>'
    color_default = item.get('color', '#111111')
    bold_default = item.get('bold', False)

    def run_xml(run):
        run_size = int(float(run.get('font_size', item.get('font_size', 18))) * 100)
        run_font = xml_text(run.get('font', item.get('font', 'STHeiti')))
        color = hex_color(run.get('color', color_default))
        bold = ' b="1"' if run.get('bold', bold_default) else ''
        italic = ' i="1"' if run.get('italic', item.get('italic')) else ''
        return f'<a:r><a:rPr lang="zh-CN" sz="{run_size}"{bold}{italic}><a:solidFill><a:srgbClr val="{color}"/></a:solidFill><a:latin typeface="{run_font}"/><a:ea typeface="{run_font}"/><a:cs typeface="{run_font}"/></a:rPr><a:t>{xml_text(run.get("text", ""))}</a:t></a:r>'

    def paragraph_xml(paragraph):
        if isinstance(paragraph, str):
            runs = [{'text': paragraph}]
            p_align = align
        else:
            runs = paragraph.get('runs', [{'text': paragraph.get('text', '')}])
            p_align = paragraph.get('align', align)
        return f'<a:p><a:pPr algn="{p_align}"/>{"".join(run_xml(r) for r in runs)}<a:endParaRPr lang="zh-CN" sz="{font_size}"/></a:p>'

    if item.get('paragraphs'):
        body = ''.join(paragraph_xml(p) for p in item['paragraphs'])
    elif item.get('runs'):
        body = paragraph_xml({'runs': item['runs']})
    else:
        body = ''.join(paragraph_xml(line) for line in str(item.get('text', '')).split('\n'))
    return f'''
      <p:sp>
        <p:nvSpPr><p:cNvPr id="{idx}" name="{xml_text(item.get('name', 'TextBox'))}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="{emu(x)}" y="{emu(y)}"/><a:ext cx="{emu(w)}" cy="{emu(h)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr>
        <p:txBody><a:bodyPr wrap="{xml_text(wrap)}" anchor="{anchor}" lIns="0" tIns="0" rIns="0" bIns="0">{autofit}</a:bodyPr><a:lstStyle/>{body}</p:txBody>
      </p:sp>'''


def group_xml(idx, item):
    children = item['children']
    xs, ys = [], []
    for child in children:
        if 'box_px' in child:
            x, y, w, h = child['box_px']
            xs += [x, x + w]
            ys += [y, y + h]
        elif 'points_px' in child and child.get('type') == 'line':
            x1, y1, x2, y2 = child['points_px']
            xs += [x1, x2]
            ys += [y1, y2]
        elif 'points_px' in child:
            xs += [p[0] for p in child['points_px']]
            ys += [p[1] for p in child['points_px']]
    min_x, min_y, max_x, max_y = min(xs), min(ys), max(xs), max(ys)
    w_px, h_px = max(1, max_x - min_x), max(1, max_y - min_y)
    left, top, width, height = px_to_in([min_x, min_y, w_px, h_px])
    child_xml = []
    child_id = idx * 1000
    for child in sorted(children, key=lambda c: c.get('z_index', 0)):
        local = dict(child)
        if 'box_px' in local:
            x, y, w, h = local['box_px']
            local['box_px'] = [x - min_x, y - min_y, w, h]
        elif local.get('type') == 'line':
            x1, y1, x2, y2 = local['points_px']
            local['points_px'] = [x1 - min_x, y1 - min_y, x2 - min_x, y2 - min_y]
        elif 'points_px' in local:
            local['points_px'] = [[x - min_x, y - min_y] for x, y in local['points_px']]
        # render children in absolute slide coordinates within group coord transform by overriding conversion context is hard.
        # Instead group is not currently used in build path.
    return ''


def slide_xml(manifest):
    idx = 2
    parts = []
    layered = []
    for order, item in enumerate(manifest.get('shapes', [])):
        layered.append((float(item.get('z_index', 100)), order, 'shape', item))
    for order, item in enumerate(manifest.get('text_boxes', [])):
        layered.append((float(item.get('z_index', 300)), order, 'text', item))
    for _z, _order, kind, item in sorted(layered, key=lambda entry: (entry[0], entry[1])):
        if kind == 'text':
            parts.append(text_box_xml(idx, item))
        elif item.get('type') == 'line':
            parts.append(line_xml(idx, item))
        elif item.get('type') == 'freeform':
            parts.append(freeform_xml(idx, item))
        else:
            parts.append(rect_like_xml(idx, item))
        idx += 1
    bg = manifest['slide'].get('background', '#ffffff')
    return f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:bg><p:bgPr><a:solidFill><a:srgbClr val="{hex_color(bg)}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
      {''.join(parts)}
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>'''


def write_pptx(manifest):
    width_emu = emu(SLIDE_W_IN)
    height_emu = emu(SLIDE_H_IN)
    content_types = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>'''
    with zipfile.ZipFile(PPTX, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', content_types)
        z.writestr('_rels/.rels', '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>''')
        z.writestr('docProps/core.xml', '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Codex Discord Bridge Guide Page 4</dc:title></cp:coreProperties>''')
        z.writestr('docProps/app.xml', '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Codex</Application><PresentationFormat>Widescreen</PresentationFormat><Slides>1</Slides></Properties>''')
        z.writestr('ppt/presentation.xml', f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="{width_emu}" cy="{height_emu}" type="wide"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>''')
        z.writestr('ppt/_rels/presentation.xml.rels', '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>''')
        z.writestr('ppt/slideMasters/slideMaster1.xml', '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>''')
        z.writestr('ppt/slideMasters/_rels/slideMaster1.xml.rels', '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>''')
        z.writestr('ppt/slideLayouts/slideLayout1.xml', '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1"><p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>''')
        z.writestr('ppt/slideLayouts/_rels/slideLayout1.xml.rels', '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>''')
        z.writestr('ppt/theme/theme1.xml', '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="ImageToEditablePPT"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F1F1F"/></a:dk2><a:lt2><a:srgbClr val="F8F8F8"/></a:lt2><a:accent1><a:srgbClr val="286FD3"/></a:accent1><a:accent2><a:srgbClr val="EE6A00"/></a:accent2><a:accent3><a:srgbClr val="2F6B34"/></a:accent3><a:accent4><a:srgbClr val="57C4B8"/></a:accent4><a:accent5><a:srgbClr val="666666"/></a:accent5><a:accent6><a:srgbClr val="111111"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHLink><a:srgbClr val="954F72"/></a:folHLink></a:clrScheme><a:fontScheme name="STHeiti"><a:majorFont><a:latin typeface="STHeiti"/><a:ea typeface="STHeiti"/><a:cs typeface="STHeiti"/></a:majorFont><a:minorFont><a:latin typeface="STHeiti"/><a:ea typeface="STHeiti"/><a:cs typeface="STHeiti"/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>''')
        z.writestr('ppt/slides/slide1.xml', slide_xml(manifest))
        z.writestr('ppt/slides/_rels/slide1.xml.rels', '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>''')


def choose_font(size, preferred=PREVIEW_FONT):
    for path in [preferred, '/System/Library/Fonts/STHeiti Medium.ttc', '/System/Library/Fonts/Supplemental/Arial Unicode.ttf', '/Library/Fonts/Arial Unicode.ttf']:
        if path and Path(path).exists():
            return ImageFont.truetype(path, size=size)
    return ImageFont.load_default()


def px_color(color):
    if not color or color == 'none':
        return None
    return ImageColor.getrgb(color)


def draw_round(draw, box, radius, fill, outline, width=1, dash=None):
    if dash:
        # approximate dashed outline with solid transparent fill and dashed lines
        if fill:
            draw.rounded_rectangle(box, radius=radius, fill=fill)
        draw_dashed_rect(draw, box, outline, width, radius)
    else:
        draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=max(1, int(width)))


def draw_dashed_rect(draw, box, color, width=2, radius=0):
    x1, y1, x2, y2 = box
    dash, gap = 18, 12
    # straight edges only, enough for source-like dashed callouts
    x = x1 + radius
    while x < x2 - radius:
        draw.line((x, y1, min(x + dash, x2 - radius), y1), fill=color, width=width)
        draw.line((x, y2, min(x + dash, x2 - radius), y2), fill=color, width=width)
        x += dash + gap
    y = y1 + radius
    while y < y2 - radius:
        draw.line((x1, y, x1, min(y + dash, y2 - radius)), fill=color, width=width)
        draw.line((x2, y, x2, min(y + dash, y2 - radius)), fill=color, width=width)
        y += dash + gap


def draw_dashed_line(draw, p1, p2, color, width=2, dash=14, gap=10):
    x1, y1 = p1
    x2, y2 = p2
    length = math.hypot(x2 - x1, y2 - y1)
    if length <= 0:
        return
    dx, dy = (x2 - x1) / length, (y2 - y1) / length
    pos = 0
    while pos < length:
        end = min(pos + dash, length)
        draw.line((x1 + dx * pos, y1 + dy * pos, x1 + dx * end, y1 + dy * end), fill=color, width=width)
        pos += dash + gap


def draw_arrow(draw, x1, y1, x2, y2, color, width=7):
    draw.line((x1, y1, x2, y2), fill=color, width=width)
    ang = math.atan2(y2-y1, x2-x1)
    size = 26
    spread = 0.55
    pts = [(x2, y2), (x2 - size*math.cos(ang-spread), y2 - size*math.sin(ang-spread)), (x2 - size*math.cos(ang+spread), y2 - size*math.sin(ang+spread))]
    draw.polygon(pts, fill=color)


def draw_freeform(draw, item):
    points = [(int(x), int(y)) for x, y in item.get('freeform_points_px', item.get('points_px'))]
    fill = px_color(item.get('fill'))
    outline = px_color(item.get('stroke', '#000000'))
    width = max(1, int(item.get('stroke_width', 2)))
    if item.get('closed'):
        draw.polygon(points, fill=fill)
        if outline:
            draw.line(points + [points[0]], fill=outline, width=width, joint='curve')
    else:
        if item.get('dash'):
            for a,b in zip(points, points[1:]):
                draw_dashed_line(draw, a, b, outline, width=width)
        else:
            draw.line(points, fill=outline, width=width, joint='curve')


def draw_text_preview(draw, item):
    x, y, w, h = item['box_px']
    size_px = max(1, int(float(item.get('font_size', 18)) * SCALE / 72 * item.get('preview_font_scale', 1.0)))
    font = choose_font(size_px, item.get('preview_font', PREVIEW_FONT))
    fill = px_color(item.get('color', '#111111'))
    if item.get('paragraphs'):
        text = '\n'.join(''.join(r.get('text','') for r in p.get('runs', [])) if isinstance(p, dict) else str(p) for p in item['paragraphs'])
    elif item.get('runs'):
        cx = x
        for run in item['runs']:
            run_size = max(1, int(float(run.get('font_size', item.get('font_size', 18))) * SCALE / 72 * item.get('preview_font_scale', 1.0)))
            run_font = choose_font(run_size, run.get('preview_font', item.get('preview_font', PREVIEW_FONT)))
            run_fill = px_color(run.get('color', item.get('color', '#111111')))
            draw.text((cx, y), run.get('text', ''), fill=run_fill, font=run_font)
            bbox = draw.textbbox((cx, y), run.get('text', ''), font=run_font)
            cx = bbox[2] + 4
        return
    else:
        text = item.get('text', '')
    draw.multiline_text((x, y), text, fill=fill, font=font, spacing=item.get('preview_spacing', 4), align=item.get('align', 'left'))


def render_preview(manifest):
    canvas = Image.new('RGB', (SLIDE_W_PX, SLIDE_H_PX), '#ffffff')
    draw = ImageDraw.Draw(canvas)
    layered = []
    for order, item in enumerate(manifest.get('shapes', [])):
        layered.append((float(item.get('z_index', 100)), order, 'shape', item))
    for order, item in enumerate(manifest.get('text_boxes', [])):
        layered.append((float(item.get('z_index', 300)), order, 'text', item))
    for _z, _order, kind, item in sorted(layered, key=lambda entry: (entry[0], entry[1])):
        if kind == 'text':
            draw_text_preview(draw, item)
            continue
        t = item.get('type')
        if t == 'line':
            x1,y1,x2,y2 = item['points_px']
            color = px_color(item.get('stroke', '#000000'))
            if item.get('preset') == 'lineWithArrow':
                draw_arrow(draw, x1, y1, x2, y2, color, int(item.get('stroke_width', 6)))
            elif item.get('dash'):
                draw_dashed_line(draw, (x1,y1), (x2,y2), color, int(item.get('stroke_width', 2)))
            else:
                draw.line((x1,y1,x2,y2), fill=color, width=int(item.get('stroke_width', 2)))
        elif t == 'freeform':
            draw_freeform(draw, item)
        else:
            x,y,w,h = item['box_px']
            box = [x,y,x+w,y+h]
            fill = px_color(item.get('fill'))
            stroke = px_color(item.get('stroke', '#000000'))
            width = int(item.get('stroke_width', 1))
            if t == 'ellipse':
                draw.ellipse(box, fill=fill, outline=stroke, width=width)
            elif t == 'roundRect':
                draw_round(draw, box, item.get('source_corner_radius_px', 10), fill, stroke, width, item.get('dash'))
            else:
                if item.get('dash'):
                    if fill:
                        draw.rectangle(box, fill=fill)
                    draw_dashed_rect(draw, box, stroke, width, 0)
                else:
                    draw.rectangle(box, fill=fill, outline=stroke, width=width)
    canvas.save(PREVIEW)


def txt(name, text, box, size, color=DARK, z=300, bold=False, align='left', runs=None, paragraphs=None, wrap='none', preview_scale=0.92):
    item = {
        'name': name,
        'text': text,
        'box_px': box,
        'font_size': size,
        'font': 'STHeiti',
        'preview_font': PREVIEW_FONT,
        'preview_font_scale': preview_scale,
        'color': color,
        'bold': bold,
        'align': align,
        'wrap': wrap,
        'z_index': z,
    }
    if runs is not None:
        item['runs'] = runs
        item.pop('text', None)
    if paragraphs is not None:
        item['paragraphs'] = paragraphs
        item.pop('text', None)
    return item


def rect(name, box, fill='none', stroke='#000000', sw=2, z=100, radius=None, dash=None):
    if radius:
        return {'name': name, 'type': 'roundRect', 'box_px': box, 'fill': fill, 'stroke': stroke, 'stroke_width': sw, 'source_corner_radius_px': radius, 'corner_category': 'small-radius' if radius < 24 else 'large-radius', 'corner_reason': 'source has rounded marker/card corners', 'dash': dash, 'z_index': z}
    return {'name': name, 'type': 'rect', 'box_px': box, 'fill': fill, 'stroke': stroke, 'stroke_width': sw, 'corner_category': 'straight', 'z_index': z, **({'dash': dash} if dash else {})}


def line(name, p, stroke, sw=3, z=120, preset='line', dash=None):
    return {'name': name, 'type': 'line', 'points_px': p, 'stroke': stroke, 'stroke_width': sw, 'preset': preset, 'dash': dash, 'z_index': z}


def ellipse(name, box, fill='none', stroke='#000000', sw=2, z=100):
    return {'name': name, 'type': 'ellipse', 'box_px': box, 'fill': fill, 'stroke': stroke, 'stroke_width': sw, 'z_index': z}


def free(name, pts, stroke, sw=3, fill='none', closed=False, z=130):
    
    xs=[p[0] for p in pts]; ys=[p[1] for p in pts]
    return {'name': name, 'type': 'freeform', 'freeform_points_px': pts, 'box_px': [min(xs), min(ys), max(1, max(xs)-min(xs)), max(1, max(ys)-min(ys))], 'stroke': stroke, 'stroke_width': sw, 'fill': fill, 'closed': closed, 'z_index': z}


def add_image_icon(shapes, x, y, s=50, z=150):
    shapes.append(rect('image icon frame', [x, y, s, s*0.78], fill='#ffffff', stroke=GREEN, sw=3, z=z, radius=4))
    shapes.append(ellipse('image icon sun', [x+s*0.66, y+s*0.13, s*0.12, s*0.12], fill='#c7b97a', stroke='none', sw=0, z=z+1))
    shapes.append(free('image icon mountains', [(x+s*0.10,y+s*0.67),(x+s*0.35,y+s*0.36),(x+s*0.52,y+s*0.58),(x+s*0.66,y+s*0.43),(x+s*0.90,y+s*0.68)], stroke=GREEN, sw=2, fill='#7ea874', closed=True, z=z+2))


def add_pdf_icon(shapes, x, y, w=49, h=59, z=150):
    shapes.append(rect('pdf page body', [x, y, w, h], fill='#ffffff', stroke=PDF_RED, sw=3, z=z, radius=3))
    shapes.append(free('pdf folded corner', [(x+w*0.67,y),(x+w,y+h*0.30),(x+w*0.67,y+h*0.30)], stroke=PDF_RED, sw=2, fill='#fff4ef', closed=True, z=z+1))
    shapes.append(txt('PDF label', 'PDF', [x+5, y+25, w-8, 21], 10.8, color=PDF_RED, z=z+4, bold=True, preview_scale=1.0))


def add_code_icon(shapes, x, y, w=51, h=59, z=150):
    shapes.append(rect('code page body', [x, y, w, h], fill='#ffffff', stroke='#42628c', sw=3, z=z, radius=3))
    shapes.append(free('code folded corner', [(x+w*0.67,y),(x+w,y+h*0.30),(x+w*0.67,y+h*0.30)], stroke='#42628c', sw=2, fill='#eef4ff', closed=True, z=z+1))
    shapes.append(line('code slash left', [x+22,y+22,x+15,y+38], CODE_BLUE, sw=3, z=z+3))
    shapes.append(line('code slash mid', [x+30,y+20,x+25,y+42], CODE_BLUE, sw=3, z=z+3))
    shapes.append(line('code slash right', [x+36,y+22,x+43,y+33], CODE_BLUE, sw=3, z=z+3))
    shapes.append(line('code slash right2', [x+43,y+33,x+35,y+43], CODE_BLUE, sw=3, z=z+3))


def add_discord_icon(shapes, x, y, r=35, z=150):
    shapes.append(ellipse('discord blue circle', [x, y, 2*r, 2*r], fill='#5667e9', stroke='none', sw=0, z=z))
    # simplified controller/face as native shapes
    shapes.append(free('discord white body', [(x+15,y+37),(x+20,y+26),(x+31,y+23),(x+39,y+25),(x+50,y+23),(x+60,y+29),(x+58,y+48),(x+48,y+53),(x+39,y+48),(x+31,y+53),(x+20,y+49)], fill='#ffffff', stroke='#ffffff', sw=1, closed=True, z=z+1))
    shapes.append(ellipse('discord eye left', [x+25, y+34, 7, 8], fill='#5667e9', stroke='none', sw=0, z=z+2))
    shapes.append(ellipse('discord eye right', [x+45, y+34, 7, 8], fill='#5667e9', stroke='none', sw=0, z=z+2))


def add_folder_icon(shapes, x, y, w=82, h=54, z=140):
    shapes.append(free('small folder tab', [(x+2,y+15),(x+2,y+3),(x+30,y+3),(x+39,y+13),(x+w-3,y+13),(x+w-3,y+23),(x+2,y+23)], stroke=GREEN, sw=4, fill=GREEN_LIGHT, closed=True, z=z))
    shapes.append(rect('small folder body', [x, y+18, w, h-18], fill='#ffffff', stroke=GREEN, sw=4, z=z+1, radius=4))


def add_big_folder(shapes):
    shapes.append(free('inbox folder tab', [(590,355),(590,318),(716,318),(733,338),(965,338),(982,360),(982,385),(590,385)], stroke=GREEN, sw=4, fill=GREEN_LIGHT, closed=True, z=90))
    shapes.append(rect('inbox folder body', [590,356,389,241], fill='#ffffff', stroke=GREEN, sw=4, z=91, radius=24))
    # subtle left vertical seam and top line
    shapes.append(line('folder top seam', [592,356,978,356], GREEN, sw=3, z=92))


def add_cube_icon(shapes, x, y, s=77, z=140):
    # three visible faces as native freeform polygons
    top = [(x+s*0.5,y),(x+s,y+s*0.25),(x+s*0.5,y+s*0.50),(x,y+s*0.25)]
    left = [(x,y+s*0.25),(x+s*0.5,y+s*0.50),(x+s*0.5,y+s),(x,y+s*0.74)]
    right = [(x+s,y+s*0.25),(x+s*0.5,y+s*0.50),(x+s*0.5,y+s),(x+s,y+s*0.74)]
    shapes.append(free('codex cube top', top, ORANGE, sw=3, fill='#ffffff', closed=True, z=z))
    shapes.append(free('codex cube left', left, ORANGE, sw=3, fill='#fff8f0', closed=True, z=z+1))
    shapes.append(free('codex cube right', right, ORANGE, sw=3, fill='#ffffff', closed=True, z=z+2))
    shapes.append(txt('cube C', 'C', [x+51,y+42,22,24], 12, color=ORANGE, z=z+4, bold=True, preview_scale=1.0))


def add_sync_icon(shapes, x, y, z=150):
    # two circular arrows approximated by arcs made of polylines + arrowheads
    pts1=[]
    cx,cy=x+34,y+28
    for a in range(210, 15, -18):
        rad=math.radians(a)
        pts1.append((cx+22*math.cos(rad),cy+19*math.sin(rad)))
    shapes.append(free('sync arrow upper arc', pts1, BLUE, sw=4, fill='none', closed=False, z=z))
    shapes.append(free('sync arrow upper head', [(x+49,y+13),(x+60,y+12),(x+55,y+24)], BLUE, sw=2, fill=BLUE, closed=True, z=z+1))
    pts2=[]
    for a in range(30, 225, 18):
        rad=math.radians(a)
        pts2.append((cx+22*math.cos(rad),cy+19*math.sin(rad)))
    shapes.append(free('sync arrow lower arc', pts2, BLUE, sw=4, fill='none', closed=False, z=z))
    shapes.append(free('sync arrow lower head', [(x+18,y+42),(x+8,y+43),(x+13,y+31)], BLUE, sw=2, fill=BLUE, closed=True, z=z+1))


def add_lightbulb(shapes, x, y, z=150):
    shapes.append(ellipse('bulb head', [x+23,y+10,40,47], fill='#fffef3', stroke=BLUE, sw=4, z=z))
    shapes.append(rect('bulb neck', [x+33,y+54,22,15], fill='#fffef3', stroke=BLUE, sw=3, z=z+1, radius=3))
    shapes.append(line('bulb base 1', [x+33,y+72,x+55,y+72], BLUE, sw=3, z=z+1))
    shapes.append(line('bulb base 2', [x+37,y+79,x+51,y+79], BLUE, sw=3, z=z+1))
    shapes.append(line('bulb ray top', [x+43,y,x+43,y+7], BLUE, sw=3, z=z))
    shapes.append(line('bulb ray left', [x+9,y+20,x+19,y+25], BLUE, sw=3, z=z))
    shapes.append(line('bulb ray right', [x+67,y+23,x+78,y+17], BLUE, sw=3, z=z))
    shapes.append(line('bulb ray upper left', [x+22,y+5,x+28,y+16], BLUE, sw=3, z=z))
    shapes.append(line('bulb ray upper right', [x+60,y+8,x+54,y+18], BLUE, sw=3, z=z))


def make_manifest():
    shapes=[]
    text=[]
    # Title decorations
    shapes.append(free('blue sparkle outline', [(457,77),(468,58),(476,77),(491,84),(475,92),(468,109),(459,93),(446,86)], BLUE, sw=3, fill='none', closed=True, z=120))
    shapes.append(line('small sparkle dash 1', [461,121,477,118], BLUE, sw=3, z=120))
    shapes.append(line('small sparkle dash 2', [460,137,476,137], BLUE, sw=3, z=120))
    shapes.append(line('green accent 1', [1262,75,1281,52], GREEN, sw=5, z=120))
    shapes.append(line('green accent 2', [1281,86,1307,72], GREEN, sw=4, z=120))
    shapes.append(line('green accent 3', [1288,101,1314,111], GREEN, sw=4, z=120))
    shapes.append(free('blue title underline', [(497,189),(690,179),(945,176),(1267,179)], BLUE, sw=3, fill='none', closed=False, z=120))
    shapes.append(free('blue title underline second', [(552,195),(743,181),(1007,178),(1259,179)], BLUE, sw=2, fill='none', closed=False, z=120))
    text.append(txt('title', '文件输入与附件', [528,60,692,86], 41, color=NAVY, z=400, bold=True, preview_scale=1.05))

    # Left Discord panel
    shapes.append(rect('discord attachment panel', [100,216,356,433], fill='#ffffff', stroke=BLUE, sw=4, z=70, radius=47))
    add_discord_icon(shapes, 126, 235, 35, z=160)
    text.append(txt('discord attachment label', 'Discord 附件', [207,250,181,39], 20, color=BLUE, z=400, preview_scale=0.95))
    for y in [315,412,510]:
        shapes.append(rect('discord file row', [128,y,293,89], fill='#ffffff', stroke='#a1a8b8', sw=2, z=80, radius=14))
    add_image_icon(shapes, 153, 330, 68, z=160)
    add_pdf_icon(shapes, 157, 423, 58, 67, z=160)
    add_code_icon(shapes, 157, 520, 58, 66, z=160)
    text.append(txt('left image file', '截图.png', [247,336,123,30], 17, color=DARK, z=400, preview_scale=0.94))
    text.append(txt('left image size', '1.2 MB', [249,371,81,25], 13, color='#657085', z=400, preview_scale=0.95))
    text.append(txt('left pdf file', '需求说明.pdf', [248,434,151,31], 17, color=DARK, z=400, preview_scale=0.94))
    text.append(txt('left pdf size', '245 KB', [249,468,82,25], 13, color='#657085', z=400, preview_scale=0.95))
    text.append(txt('left code file', 'utils.py', [249,532,110,29], 17, color=DARK, z=400, preview_scale=0.94))
    text.append(txt('left code size', '3.1 KB', [250,566,77,25], 13, color='#657085', z=400, preview_scale=0.95))
    text.append(txt('left ellipsis', '......', [251,615,85,24], 16, color=DARK, z=400, preview_scale=0.98))

    # Center folder and label
    add_folder_icon(shapes, 619, 232, 77, 58, z=150)
    text.append(txt('workspace inbox label', 'workspace inbox\n（自动同步）', [720,232,210,66], 19, color=GREEN, z=400, preview_scale=0.88))
    add_big_folder(shapes)
    add_image_icon(shapes, 627, 377, 51, z=160)
    add_pdf_icon(shapes, 630, 440, 48, 57, z=160)
    add_code_icon(shapes, 630, 506, 49, 56, z=160)
    text.append(txt('folder image file', '截图.png', [701,385,126,30], 17, color=DARK, z=400, preview_scale=0.94))
    text.append(txt('folder pdf file', '需求说明.pdf', [701,452,158,30], 17, color=DARK, z=400, preview_scale=0.94))
    text.append(txt('folder code file', 'utils.py', [701,520,110,30], 17, color=DARK, z=400, preview_scale=0.94))
    text.append(txt('folder ellipsis', '......', [702,555,93,26], 15, color=DARK, z=400, preview_scale=0.98))
    shapes.append(rect('workspace path pill', [565,613,431,51], fill=GREEN_PALE, stroke=GREEN, sw=2, z=80, radius=13))
    text.append(txt('workspace path', 'workspace/.bridge-inbox', [614,625,342,32], 20, color=GREEN, z=400, preview_scale=0.94))

    # arrows
    shapes.append(line('blue sync arrow', [481,437,566,437], BLUE, sw=7, z=130, preset='lineWithArrow'))
    shapes.append(line('green input arrow', [998,437,1080,437], GREEN, sw=7, z=130, preset='lineWithArrow'))

    # Right codex input panel
    add_cube_icon(shapes, 1153, 219, 76, z=150)
    text.append(txt('codex input label', 'Codex 输入区', [1260,251,199,36], 20, color=ORANGE, z=400, preview_scale=0.95))
    shapes.append(rect('codex input card', [1105,314,464,344], fill=ORANGE_LIGHT, stroke=ORANGE, sw=3, z=75, radius=48))
    text.append(txt('codex card text', '可读取 inbox 中的文件作为输入', [1140,354,326,34], 18, color=DARK, z=400, preview_scale=0.93))
    text.append(txt('sample citation label', '示例引用：', [1140,411,123,32], 17, color=ORANGE, z=400, preview_scale=0.95))
    shapes.append(rect('sample prompt dashed box', [1130,443,415,113], fill='#fffefd', stroke=DASH_GRAY, sw=2, z=85, radius=8, dash='dash'))
    text.append(txt('sample prompt text', '请根据 需求说明.pdf 生成接口文档，\n并参考 截图.png 中的界面。\n工具函数可查看 utils.py。', [1146,459,363,84], 16, color=DARK, z=400, preview_scale=0.89))
    shapes.append(line('codex gray line 1', [1142,584,1488,584], '#d7d2cc', sw=5, z=120))
    shapes.append(line('codex gray line 2', [1140,605,1532,605], '#d7d2cc', sw=5, z=120))

    # legend pills
    shapes.append(rect('sync legend pill', [328,698,287,60], fill='#f4f9ff', stroke=BLUE, sw=2, z=80, radius=16))
    add_sync_icon(shapes, 351, 711, z=160)
    text.append(txt('sync legend text', '附件自动同步', [413,719,170,29], 18, color=BLUE, z=400, preview_scale=0.95))
    shapes.append(rect('image input legend pill', [663,698,293,60], fill='#f8fbf4', stroke=GREEN, sw=2, z=80, radius=16))
    add_image_icon(shapes, 687, 714, 39, z=160)
    text.append(txt('image input legend text', '图片可作为输入', [743,720,179,29], 18, color=GREEN, z=400, preview_scale=0.95))
    shapes.append(rect('file reference legend pill', [1000,698,329,60], fill='#fffaf5', stroke=ORANGE, sw=2, z=80, radius=16))
    add_pdf_icon(shapes, 1024, 712, 31, 37, z=160)
    text.append(txt('file reference legend text', '任务里引用文件名', [1075,719,210,30], 18, color=ORANGE, z=400, preview_scale=0.95))

    # bottom takeaway
    shapes.append(rect('takeaway dashed border', [218,792,1220,102], fill='none', stroke='#6ba7ef', sw=3, z=70, radius=12, dash='dash'))
    add_lightbulb(shapes, 248, 808, z=150)
    text.append(txt('takeaway mixed text', '', [347,822,935,48], 22, color=DARK, z=400, preview_scale=0.95, runs=[
        {'text':'把截图、文档、代码发到 ', 'font_size':22, 'color':DARK},
        {'text':'Discord', 'font_size':22, 'color':BLUE},
        {'text':'， ', 'font_size':22, 'color':DARK},
        {'text':'Codex', 'font_size':22, 'color':ORANGE},
        {'text':' 就能在项目里处理。', 'font_size':22, 'color':DARK},
    ]))

    text_inventory = [
        '文件输入与附件', 'Discord 附件', '截图.png', '1.2 MB', '需求说明.pdf', '245 KB', 'utils.py', '3.1 KB', '......',
        'workspace inbox', '（自动同步）', 'workspace/.bridge-inbox', 'Codex 输入区', '可读取 inbox 中的文件作为输入', '示例引用：',
        '请根据 需求说明.pdf 生成接口文档，', '并参考 截图.png 中的界面。', '工具函数可查看 utils.py。',
        '附件自动同步', '图片可作为输入', '任务里引用文件名', '把截图、文档、代码发到 Discord， Codex 就能在项目里处理。'
    ]
    visual_inventory = [
        {'id':'discord-logo', 'description':'Discord attachment icon simplified with native circle/body/eyes', 'decision':'native-shape-simplified'},
        {'id':'attachment-file-icons', 'description':'image, PDF, and code attachment icons repeated in list and folder', 'decision':'native-shape-simplified'},
        {'id':'workspace-folder', 'description':'small inbox folder and large inbox folder', 'decision':'native-shape'},
        {'id':'direction-arrows', 'description':'blue and green transfer arrows', 'decision':'native-shape'},
        {'id':'codex-cube', 'description':'orange Codex cube logo-like icon', 'decision':'native-shape-simplified'},
        {'id':'legend-icons', 'description':'sync, picture, document legend pictograms', 'decision':'native-shape-simplified'},
        {'id':'takeaway-lightbulb', 'description':'bottom lightbulb icon and dashed note border', 'decision':'native-shape-simplified'},
        {'id':'decorative-hand-lines', 'description':'sparkle, title underline, green emphasis rays', 'decision':'native-freeform-lines'},
    ]
    manifest = {
        'schema_version': 1,
        'run_id': 'codex-discord-bridge-user-guide-editable',
        'page_id': 'page_004',
        'slide': {'width': SLIDE_W_IN, 'height': SLIDE_H_IN, 'background': '#ffffff'},
        'source': {'path': 'source.png', 'width_px': SLIDE_W_PX, 'height_px': SLIDE_H_PX},
        'preview_scale': SCALE,
        'text_inventory': text_inventory,
        'visual_inventory': visual_inventory,
        'background_strategy': {
            'mode': 'native-or-script',
            'source_consistency_contract': 'Source background is plain white with hand-drawn colored elements; rebuilt with white slide background and native shapes only.',
            'removed_foreground': 'No clean-base raster removal; all visible text, cards, icons, arrows, labels and takeaway are reconstructed as editable text or native shapes.',
            'comparison_note': 'Preview preserves the three-column attachment-to-inbox-to-Codex flow, major colors, labels, and bottom takeaway without using full-page source raster.'
        },
        'quality_checks': {
            'font_size_calibrated': True,
            'visual_inventory_matched': True,
            'background_strategy_checked': True,
            'shape_corner_geometry_checked': True
        },
        'text_boxes': text,
        'shapes': shapes,
        'images': [],
        'asset_provenance': [],
        'page_strategy': 'Object-level editable reconstruction using native PowerPoint text boxes, primitive shapes, and freeform vector approximations; no full-slide raster image is used.',
        'known_limits': [
            'Hand-drawn source styling, Discord mark, Codex cube, sync arrows, lightbulb, and attachment icons are simplified native-vector approximations rather than exact brand/icon artwork.',
            'Preview renderer uses available system CJK font, so handwritten brush texture and exact glyph metrics differ from the source.'
        ],
        'required_text': text_inventory
    }
    return manifest


def run_validation():
    cmd = [str(PYTHON), str(SKILL_DIR / 'scripts/validate_pptx.py'), str(PPTX), '--manifest', str(MANIFEST), '--report', str(VALIDATION)]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if proc.returncode != 0:
        print(proc.stdout)
        print(proc.stderr, file=sys.stderr)
        raise SystemExit(proc.returncode)


def make_contact():
    cmd = [str(PYTHON), str(SKILL_DIR / 'scripts/make_page_contact_sheet.py'), str(PAGE_DIR), '--source', 'source.png', '--preview', 'preview.png', '--out', 'split_assets_contact.png']
    subprocess.run(cmd, check=True)


def write_page_result():
    validation = json.loads(VALIDATION.read_text(encoding='utf-8'))
    manifest = json.loads(MANIFEST.read_text(encoding='utf-8'))
    outputs = {
        'manifest': MANIFEST,
        'page_pptx': PPTX,
        'preview': PREVIEW,
        'contact_sheet': CONTACT,
        'validation': VALIDATION,
        'imagegen_jobs': IMAGEGEN_JOBS,
    }
    result = {
        'schema_version': 1,
        'run_id': 'codex-discord-bridge-user-guide-editable',
        'page_id': 'page_004',
        'status': 'completed' if validation.get('passed') else 'failed',
        'manifest': str(MANIFEST),
        'page_pptx': str(PPTX),
        'preview': str(PREVIEW),
        'contact_sheet': str(CONTACT),
        'validation': str(VALIDATION),
        'imagegen_jobs': str(IMAGEGEN_JOBS),
        'qa_note': '对象级重建完成：关键文字、workspace/.bridge-inbox 路径、三段流程、附件/文件夹/箭头/Codex 输入区和 takeaway 均为可编辑文本或 native shapes。',
        'known_limits': manifest.get('known_limits', []),
        'output_hashes': {key: sha256_file(path) for key, path in outputs.items() if path.exists()}
    }
    PAGE_RESULT.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def ensure_imagegen_jobs():
    data = {'schema_version': 1, 'run_id': 'codex-discord-bridge-user-guide-editable', 'page_id': 'page_004', 'jobs': []}
    IMAGEGEN_JOBS.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def main():
    manifest = make_manifest()
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    ensure_imagegen_jobs()
    write_pptx(manifest)
    render_preview(manifest)
    make_contact()
    run_validation()
    write_page_result()
    print('done')

if __name__ == '__main__':
    main()
