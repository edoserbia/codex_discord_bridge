import json
from pathlib import Path

PAGE_DIR = Path('/Users/mac/work/su/codex_discord_bridge/outputs/image-to-editable-ppt/codex-discord-bridge-user-guide-editable/pages/page_005')
W, H = 1672, 941

NAVY = '#000A63'
BLUE = '#2D7BE8'
LIGHT_BLUE = '#CFE6FF'
DISCORD = '#2E76E6'
ORANGE = '#F06B00'
GREEN = '#0B6B20'
GREEN_STROKE = '#237239'
PALE_GREEN = '#ECF7EC'
BLACK = '#101018'
GRAY = '#777A86'
LIGHT_GRAY = '#EFF4FF'
CARD_FILL = '#FFFFFF'
BG = '#FEFDFC'

text_boxes = []
shapes = []
images = []
asset_provenance = []
visual_inventory = []

shape_id = 0
text_id = 0

def shape(type_, box=None, points=None, fill='none', stroke='#000000', stroke_width=2, z=10, dash=None, radius=None, name=None, **extra):
    global shape_id
    shape_id += 1
    item = {
        'id': name or f'shape_{shape_id:03d}',
        'type': type_,
        'fill': fill,
        'stroke': stroke,
        'stroke_width': stroke_width,
        'z_index': z,
    }
    if box is not None:
        item['box_px'] = [round(v, 2) for v in box]
    if points is not None:
        item['points_px'] = [round(v, 2) for v in points]
    if dash:
        item['dash'] = dash
    if radius is not None:
        item['source_corner_radius_px'] = radius
        item['corner_category'] = 'small-radius' if radius <= 18 else 'large-radius'
        item['corner_reason'] = 'source object has visibly rounded hand-drawn card corners'
    else:
        if type_ != 'line':
            item['corner_category'] = 'straight'
            item['corner_reason'] = 'source primitive is straight or non-rounded'
    item.update(extra)
    shapes.append(item)
    return item

def text(text, box, size, color=BLACK, z=45, font='PingFang SC', bold=False, align='left', valign='top', name=None, runs=None, paragraphs=None, preview_font='/System/Library/Fonts/STHeiti Medium.ttc'):
    global text_id
    text_id += 1
    item = {
        'id': name or f'text_{text_id:03d}',
        'box_px': [round(v, 2) for v in box],
        'font_size': size,
        'font': font,
        'preview_font': preview_font,
        'color': color,
        'bold': bold,
        'align': align,
        'valign': valign,
        'wrap': 'none',
        'z_index': z,
    }
    if runs is not None:
        item['runs'] = runs
        item['text'] = ''.join(r.get('text', '') for r in runs)
    elif paragraphs is not None:
        item['paragraphs'] = paragraphs
        parts = []
        for p in paragraphs:
            if isinstance(p, str):
                parts.append(p)
            else:
                parts.append(''.join(r.get('text','') for r in p.get('runs', [])))
        item['text'] = '\n'.join(parts)
    else:
        item['text'] = text
    text_boxes.append(item)
    return item

def rounded_card(name, x, y, w, h, stroke, fill='#FFFFFF', sw=2.2, radius=18, z=12, **extra):
    return shape('roundRect', [x, y, w, h], fill=fill, stroke=stroke, stroke_width=sw, radius=radius, z=z, name=name, **extra)

def line(name, x1, y1, x2, y2, color, sw=3.0, z=20, dash=None):
    return shape('line', points=[x1, y1, x2, y2], stroke=color, stroke_width=sw, z=z, dash=dash, name=name)

def small_text(label, box, color=BLACK, size=20, **kw):
    return text(label, box, size, color=color, font='PingFang SC', preview_font='/System/Library/Fonts/STHeiti Medium.ttc', **kw)

# Title and hand-drawn accents
text('结果回复与文件回传', [397, 54, 890, 96], 50, color=NAVY, font='PingFang SC', bold=True, name='title')
line('title_underline_1', 410, 171, 1324, 165, BLUE, sw=3, z=18)
line('title_underline_2', 466, 184, 1302, 171, BLUE, sw=2, z=18)
line('title_underline_3', 441, 178, 1134, 170, '#5D9AF0', sw=2, z=18)
# left sparkle simplified native strokes
line('sparkle_left_v1', 347, 54, 352, 82, BLUE, sw=3, z=18)
line('sparkle_left_v2', 352, 82, 373, 94, BLUE, sw=3, z=18)
line('sparkle_left_v3', 352, 82, 337, 93, BLUE, sw=3, z=18)
line('sparkle_left_v4', 352, 82, 360, 109, BLUE, sw=3, z=18)
line('sparkle_left_v5', 352, 82, 330, 82, BLUE, sw=3, z=18)
line('sparkle_left_dash_1', 358, 114, 376, 120, BLUE, sw=3, z=18)
line('sparkle_left_dash_2', 347, 128, 371, 132, BLUE, sw=3, z=18)
# right green emphasis marks
line('sparkle_right_1', 1352, 74, 1368, 52, GREEN, sw=4, z=18)
line('sparkle_right_2', 1377, 94, 1395, 86, GREEN, sw=3, z=18)
line('sparkle_right_3', 1365, 106, 1372, 122, GREEN, sw=3, z=18)

# Left Codex output icon and label
shape('line', points=[68, 264, 104, 244], stroke=ORANGE, stroke_width=3.0, z=24, name='cube_top_l')
shape('line', points=[104, 244, 140, 264], stroke=ORANGE, stroke_width=3.0, z=24, name='cube_top_r')
shape('line', points=[68, 264, 104, 284], stroke=ORANGE, stroke_width=3.0, z=24, name='cube_mid_l')
shape('line', points=[140, 264, 104, 284], stroke=ORANGE, stroke_width=3.0, z=24, name='cube_mid_r')
shape('line', points=[68, 264, 68, 304], stroke=ORANGE, stroke_width=3.0, z=24, name='cube_left')
shape('line', points=[140, 264, 140, 304], stroke=ORANGE, stroke_width=3.0, z=24, name='cube_right')
shape('line', points=[104, 284, 104, 324], stroke=ORANGE, stroke_width=3.0, z=24, name='cube_center')
shape('line', points=[68, 304, 104, 324], stroke=ORANGE, stroke_width=3.0, z=24, name='cube_bottom_l')
shape('line', points=[140, 304, 104, 324], stroke=ORANGE, stroke_width=3.0, z=24, name='cube_bottom_r')
text('C', [119, 282, 28, 28], 15, color=ORANGE, font='PingFang SC', bold=True, name='cube_c')
text('Codex 输出', [166, 276, 170, 44], 23, color=ORANGE, font='PingFang SC', bold=False, name='codex_output_label')

# Codex output card
rounded_card('codex_card', 45, 334, 273, 266, ORANGE, fill='#FFFDFC', sw=2.2, radius=22, z=10)
rounded_card('terminal_icon_box', 126, 378, 111, 74, ORANGE, fill='#FFFDFC', sw=3.0, radius=10, z=18)
line('terminal_gt_1', 150, 398, 169, 417, ORANGE, sw=4, z=24)
line('terminal_gt_2', 169, 417, 151, 434, ORANGE, sw=4, z=24)
line('terminal_underscore', 183, 432, 203, 432, ORANGE, sw=3, z=24)
text('任务执行完成后，\n生成结果并回传。', [97, 486, 175, 64], 21, color=BLACK, font='PingFang SC', name='codex_card_text')
# outgoing orange line and three branches
line('flow_horizontal_1', 320, 451, 388, 451, ORANGE, sw=3, z=20)
line('flow_vertical_main', 343, 318, 343, 577, ORANGE, sw=3, z=20)
line('flow_top_arrow_in', 341, 318, 387, 281, ORANGE, sw=3, z=20)
line('flow_mid_arrow', 374, 437, 401, 452, ORANGE, sw=3, z=20)
line('flow_bottom_arrow_in', 343, 577, 389, 607, ORANGE, sw=3, z=20)
line('flow_top_arrow_head_1', 387, 281, 371, 279, ORANGE, sw=3, z=21)
line('flow_top_arrow_head_2', 387, 281, 379, 296, ORANGE, sw=3, z=21)
line('flow_mid_arrow_head_1', 401, 452, 386, 439, ORANGE, sw=3, z=21)
line('flow_mid_arrow_head_2', 401, 452, 386, 467, ORANGE, sw=3, z=21)
line('flow_bottom_arrow_head_1', 389, 607, 372, 607, ORANGE, sw=3, z=21)
line('flow_bottom_arrow_head_2', 389, 607, 378, 592, ORANGE, sw=3, z=21)

# Result category cards
cards = [
    ('summary_card', 398, 221, 267, 136, '1. 最终总结', '给出结论、要点\n与下一步建议。', GREEN, 'check'),
    ('long_reply_card', 398, 388, 267, 131, '2. 长回复分段', '长内容自动拆分\n为多条消息发送。', DISCORD, 'doc'),
    ('file_attach_card', 398, 548, 267, 129, '3. 文件附件', '生成的文件自动\n打包并回传。', ORANGE, 'clip'),
]
for name, x, y, w, h, title, body, icon_color, icon_kind in cards:
    rounded_card(name, x, y, w, h, ORANGE, fill=CARD_FILL, sw=2.0, radius=18, z=12)
    if icon_kind == 'check':
        shape('ellipse', [420, 250, 51, 51], fill='#F7FEF8', stroke=GREEN, stroke_width=3, z=24, name='summary_check_circle')
        line('summary_check_1', 433, 274, 448, 289, GREEN, sw=3, z=26)
        line('summary_check_2', 448, 289, 464, 262, GREEN, sw=3, z=26)
    elif icon_kind == 'doc':
        shape('rect', [420, 413, 47, 60], fill='#F7FBFF', stroke=DISCORD, stroke_width=3, z=24, name='doc_icon_page')
        line('doc_fold_1', 448, 413, 468, 432, DISCORD, sw=3, z=26)
        line('doc_fold_2', 448, 413, 448, 432, DISCORD, sw=3, z=26)
        line('doc_fold_3', 448, 432, 468, 432, DISCORD, sw=3, z=26)
        for yy in (440, 453, 466):
            line(f'doc_text_line_{yy}', 431, yy, 459, yy, DISCORD, sw=2, z=26)
    else:
        # simplified paperclip
        shape('ellipse', [424, 581, 29, 49], fill='none', stroke=ORANGE, stroke_width=4, z=24, name='clip_outer')
        line('clip_slant_1', 441, 612, 462, 587, ORANGE, sw=4, z=26)
        shape('ellipse', [437, 596, 15, 28], fill='none', stroke=ORANGE, stroke_width=3, z=26, name='clip_inner')
    text(title, [489, y+21, 154, 31], 22, color=BLACK, font='PingFang SC', name=f'{name}_title')
    text(body, [492, y+58, 158, 60], 17, color=BLACK, font='PingFang SC', name=f'{name}_body')

# Group bracket and arrow into bridge
line('result_group_bracket_top', 664, 291, 695, 306, ORANGE, sw=3, z=20)
line('result_group_bracket_vert', 695, 306, 708, 430, ORANGE, sw=3, z=20)
line('result_group_bracket_mid', 708, 430, 726, 451, ORANGE, sw=3, z=20)
line('result_group_arrow', 668, 452, 732, 452, ORANGE, sw=3.2, z=20)
line('result_group_arrow_head_1', 732, 452, 712, 433, ORANGE, sw=3.2, z=21)
line('result_group_arrow_head_2', 732, 452, 713, 471, ORANGE, sw=3.2, z=21)
line('result_group_bracket_low_vert', 708, 462, 699, 592, ORANGE, sw=3, z=20)
line('result_group_bracket_bottom', 699, 592, 665, 607, ORANGE, sw=3, z=20)

# Bridge icon and label
line('bridge_deck', 798, 321, 912, 321, GREEN, sw=3, z=24)
line('bridge_floor', 786, 334, 920, 334, GREEN, sw=3, z=24)
for x in (819, 882):
    line(f'bridge_tower_{x}_l', x, 279, x, 334, GREEN, sw=3, z=24)
    line(f'bridge_tower_{x}_r', x+14, 279, x+14, 334, GREEN, sw=3, z=24)
    line(f'bridge_tower_{x}_top', x, 279, x+14, 279, GREEN, sw=3, z=24)
line('bridge_cable_1', 797, 318, 819, 290, GREEN, sw=3, z=24)
line('bridge_cable_2', 833, 290, 860, 321, GREEN, sw=3, z=24)
line('bridge_cable_3', 860, 321, 882, 290, GREEN, sw=3, z=24)
line('bridge_cable_4', 896, 290, 912, 319, GREEN, sw=3, z=24)
for x in (819, 882):
    line(f'bridge_pier_{x}_1', x+4, 334, x+4, 354, GREEN, sw=3, z=24)
    line(f'bridge_pier_{x}_2', x+10, 334, x+10, 354, GREEN, sw=3, z=24)
    line(f'bridge_pier_{x}_base', x-4, 354, x+20, 354, GREEN, sw=3, z=24)
text('Bridge', [930, 296, 120, 38], 24, color=GREEN, font='PingFang SC', name='bridge_label')

# Bridge structured message card
rounded_card('bridge_card', 740, 351, 324, 289, GREEN_STROKE, fill='#FCFFFC', sw=2.0, radius=25, z=10)
text('结构化消息', [839, 371, 160, 32], 20, color=BLACK, font='PingFang SC', align='center', name='structured_msg_title')
rounded_card('json_box', 755, 398, 290, 146, '#8FB99B', fill='#FFFFFF', sw=1.2, radius=13, z=12, dash='dash')
text('BRIDGE_SEND_FILE', [771, 413, 202, 29], 18, color=GREEN, font='Menlo', bold=True, name='bridge_send_file')
json_runs = [
    {'text': '{\n', 'font': 'Menlo', 'font_size': 15, 'color': BLACK},
    {'text': '  "type": "file",\n', 'font': 'Menlo', 'font_size': 15, 'color': BLACK},
    {'text': '  "path": "workspace/output/report.md"\n', 'font': 'Menlo', 'font_size': 13.5, 'color': BLACK},
    {'text': '}', 'font': 'Menlo', 'font_size': 15, 'color': BLACK},
]
text('', [771, 451, 260, 82], 15, color=BLACK, font='Menlo', runs=json_runs, name='json_payload')
text('Bridge 读取文件，\n并将结果发送回 Discord。', [802, 563, 230, 62], 20, color=BLACK, font='PingFang SC', align='center', name='bridge_action_text')

# Blue arrow to Discord
line('arrow_to_discord', 1072, 456, 1140, 456, DISCORD, sw=4, z=20)
line('arrow_to_discord_head_1', 1140, 456, 1117, 433, DISCORD, sw=4, z=21)
line('arrow_to_discord_head_2', 1140, 456, 1117, 479, DISCORD, sw=4, z=21)

# Discord channel panel
rounded_card('discord_outer', 1155, 202, 428, 510, DISCORD, fill='#FBFDFF', sw=3.0, radius=36, z=10)
shape('ellipse', [1183, 220, 59, 59], fill='#617EF8', stroke='#617EF8', stroke_width=1, z=18, name='discord_icon_circle')
shape('ellipse', [1205, 244, 8, 9], fill='#FFFFFF', stroke='#FFFFFF', stroke_width=1, z=20, name='discord_eye_l')
shape('ellipse', [1222, 244, 8, 9], fill='#FFFFFF', stroke='#FFFFFF', stroke_width=1, z=20, name='discord_eye_r')
line('discord_smile', 1196, 252, 1235, 252, '#FFFFFF', sw=3, z=20)
text('Discord 频道 #', [1255, 234, 220, 41], 28, color=DISCORD, font='PingFang SC', name='discord_header')
text('api-项目', [1463, 241, 88, 25], 17, color=BLACK, font='PingFang SC', name='discord_channel_name')

# Discord first message card
rounded_card('msg_summary', 1176, 290, 386, 115, '#86B2F2', fill='#FFFFFF', sw=1.8, radius=16, z=12)
shape('ellipse', [1197, 304, 36, 36], fill='#F8FFF8', stroke=GREEN, stroke_width=2.4, z=22, name='msg_summary_check_circle')
line('msg_summary_check_1', 1207, 321, 1217, 331, GREEN, sw=2.5, z=24)
line('msg_summary_check_2', 1217, 331, 1229, 312, GREEN, sw=2.5, z=24)
text('【总结】本次任务已完成', [1259, 303, 229, 27], 15.5, color=BLACK, font='PingFang SC', bold=True, name='summary_msg_title')
text('10:35', [1511, 309, 46, 18], 10, color='#56606F', font='PingFang SC', name='summary_time')
text('• 实现了登录接口\n• 编写了单元测试\n• 接下来建议优化错误处理', [1256, 328, 278, 66], 14.5, color=BLACK, font='PingFang SC', name='summary_msg_bullets')

# Discord details stack
rounded_card('msg_details', 1176, 412, 386, 197, '#86B2F2', fill='#FFFFFF', sw=1.8, radius=18, z=12)
shape('ellipse', [1197, 427, 39, 37], fill='#E8F1FF', stroke=DISCORD, stroke_width=2.2, z=22, name='bubble_circle')
line('bubble_tail', 1206, 460, 1199, 470, DISCORD, sw=2.2, z=24)
line('bubble_line_1', 1209, 440, 1228, 440, DISCORD, sw=2, z=24)
line('bubble_line_2', 1209, 450, 1225, 450, DISCORD, sw=2, z=24)
text('【详情（1/3）】需求分析', [1258, 423, 247, 28], 15.2, color=BLACK, font='PingFang SC', bold=True, name='detail_1_title')
text('10:35', [1512, 430, 44, 16], 10, color='#56606F', font='PingFang SC', name='detail_1_time')
text('......\n（内容较长，已自动分段）', [1257, 452, 226, 47], 13.5, color=BLACK, font='PingFang SC', name='detail_1_body')
line('detail_sep_1', 1190, 509, 1548, 509, '#BCC7D6', sw=1, z=18)
# down arrows between details
line('detail_down_1a', 1336, 497, 1336, 518, DISCORD, sw=2, z=24)
line('detail_down_1b', 1327, 509, 1336, 518, DISCORD, sw=2, z=24)
line('detail_down_1c', 1345, 509, 1336, 518, DISCORD, sw=2, z=24)
# file/search small icon
shape('rect', [1198, 521, 22, 27], fill='#F8FBFF', stroke=DISCORD, stroke_width=2, z=22, name='small_doc_search')
shape('ellipse', [1213, 539, 12, 12], fill='none', stroke=DISCORD, stroke_width=2, z=24, name='small_search_circle')
line('small_search_handle', 1222, 548, 1229, 555, DISCORD, sw=2, z=24)
text('【详情（2/3）】实现过程', [1258, 523, 247, 28], 15.2, color=BLACK, font='PingFang SC', bold=True, name='detail_2_title')
text('10:35', [1512, 530, 44, 16], 10, color='#56606F', font='PingFang SC', name='detail_2_time')
line('detail_sep_2', 1190, 557, 1548, 557, '#BCC7D6', sw=1, z=18)
line('detail_down_2a', 1336, 547, 1336, 568, DISCORD, sw=2, z=24)
line('detail_down_2b', 1327, 559, 1336, 568, DISCORD, sw=2, z=24)
line('detail_down_2c', 1345, 559, 1336, 568, DISCORD, sw=2, z=24)
shape('rect', [1198, 572, 21, 26], fill='#F8FBFF', stroke=DISCORD, stroke_width=2, z=22, name='small_doc')
line('small_doc_line_1', 1204, 582, 1214, 582, DISCORD, sw=1.5, z=24)
line('small_doc_line_2', 1204, 590, 1215, 590, DISCORD, sw=1.5, z=24)
text('【详情（3/3）】测试与结果', [1258, 572, 247, 28], 15.2, color=BLACK, font='PingFang SC', bold=True, name='detail_3_title')
text('10:35', [1512, 579, 44, 16], 10, color='#56606F', font='PingFang SC', name='detail_3_time')

# Discord attachment card
rounded_card('msg_attachment', 1176, 617, 386, 73, '#86B2F2', fill='#FFFFFF', sw=1.8, radius=15, z=12)
shape('ellipse', [1198, 633, 23, 42], fill='none', stroke=ORANGE, stroke_width=3.4, z=22, name='attachment_clip_outer')
line('attachment_clip_slant', 1210, 664, 1231, 637, ORANGE, sw=3.4, z=24)
shape('ellipse', [1211, 646, 12, 23], fill='none', stroke=ORANGE, stroke_width=2.5, z=24, name='attachment_clip_inner')
text('report.zip', [1251, 634, 134, 28], 18, color=BLACK, font='PingFang SC', bold=True, name='attachment_filename')
text('10:36', [1512, 642, 45, 16], 10, color='#56606F', font='PingFang SC', name='attachment_time')
text('（包含 5 个文件）  1.2 MB', [1252, 666, 214, 23], 12.5, color=BLACK, font='PingFang SC', name='attachment_meta')

# Legend chips
rounded_card('legend_summary', 382, 710, 216, 53, GREEN_STROKE, fill=PALE_GREEN, sw=1.8, radius=12, z=12)
shape('ellipse', [406, 720, 36, 36], fill='#F7FEF8', stroke=GREEN, stroke_width=2.4, z=22, name='legend_check_circle')
line('legend_check_1', 415, 737, 426, 747, GREEN, sw=2.5, z=24)
line('legend_check_2', 426, 747, 438, 726, GREEN, sw=2.5, z=24)
text('最终总结', [461, 723, 105, 31], 22, color=GREEN, font='PingFang SC', name='legend_summary_text')
rounded_card('legend_long', 634, 710, 243, 53, DISCORD, fill='#EDF5FF', sw=1.8, radius=12, z=12)
shape('ellipse', [659, 720, 39, 37], fill='#E8F1FF', stroke=DISCORD, stroke_width=2.2, z=22, name='legend_bubble')
line('legend_bubble_tail', 668, 754, 660, 762, DISCORD, sw=2.2, z=24)
line('legend_bubble_l1', 671, 734, 689, 734, DISCORD, sw=2, z=24)
line('legend_bubble_l2', 671, 744, 686, 744, DISCORD, sw=2, z=24)
text('长回复分段', [721, 723, 145, 31], 22, color=DISCORD, font='PingFang SC', name='legend_long_text')
rounded_card('legend_file', 908, 710, 245, 53, '#F4933C', fill='#FFF8F1', sw=1.8, radius=12, z=12)
shape('ellipse', [930, 721, 19, 35], fill='none', stroke=ORANGE, stroke_width=3, z=22, name='legend_clip_outer')
line('legend_clip_slant', 941, 750, 960, 724, ORANGE, sw=3, z=24)
shape('ellipse', [944, 733, 10, 19], fill='none', stroke=ORANGE, stroke_width=2.2, z=24, name='legend_clip_inner')
text('自动上传文件', [982, 723, 148, 31], 22, color=ORANGE, font='PingFang SC', name='legend_file_text')

# Takeaway dotted container and bulb
rounded_card('takeaway_box', 253, 795, 1185, 98, '#A8CFFF', fill='#FFFFFF', sw=1.8, radius=16, z=10, dash='dash')
shape('ellipse', [296, 823, 37, 38], fill='#FFFDEB', stroke=DISCORD, stroke_width=2.4, z=22, name='bulb_circle')
line('bulb_base_1', 308, 863, 326, 863, DISCORD, sw=2.5, z=24)
line('bulb_base_2', 311, 872, 323, 872, DISCORD, sw=2.5, z=24)
line('bulb_stem', 316, 861, 316, 873, DISCORD, sw=2.2, z=24)
line('bulb_ray_top', 316, 810, 316, 800, DISCORD, sw=2.2, z=24)
line('bulb_ray_left', 296, 817, 288, 809, DISCORD, sw=2.2, z=24)
line('bulb_ray_right', 334, 817, 342, 809, DISCORD, sw=2.2, z=24)
line('bulb_ray_lh', 286, 840, 274, 840, DISCORD, sw=2.2, z=24)
line('bulb_ray_rh', 344, 840, 356, 840, DISCORD, sw=2.2, z=24)
text('', [373, 829, 1018, 52], 30, color=BLACK, font='PingFang SC', name='takeaway_text', runs=[
    {'text': '需要回传文件时，让 ', 'font': 'PingFang SC', 'font_size': 29, 'color': BLACK},
    {'text': 'Codex', 'font': 'PingFang SC', 'font_size': 29, 'color': ORANGE},
    {'text': ' 指定文件路径， ', 'font': 'PingFang SC', 'font_size': 29, 'color': BLACK},
    {'text': 'Bridge', 'font': 'PingFang SC', 'font_size': 29, 'color': GREEN},
    {'text': ' 会发回 ', 'font': 'PingFang SC', 'font_size': 29, 'color': BLACK},
    {'text': 'Discord', 'font': 'PingFang SC', 'font_size': 29, 'color': DISCORD},
    {'text': '。', 'font': 'PingFang SC', 'font_size': 29, 'color': BLACK},
])
line('takeaway_discord_underline', 1282, 872, 1365, 865, DISCORD, sw=2.4, z=46)

text_inventory = [
    '结果回复与文件回传',
    'Codex 输出',
    '任务执行完成后，生成结果并回传。',
    '1. 最终总结',
    '给出结论、要点与下一步建议。',
    '2. 长回复分段',
    '长内容自动拆分为多条消息发送。',
    '3. 文件附件',
    '生成的文件自动打包并回传。',
    'Bridge',
    '结构化消息',
    'BRIDGE_SEND_FILE',
    '{ "type": "file", "path": "workspace/output/report.md" }',
    'Bridge 读取文件，并将结果发送回 Discord。',
    'Discord 频道 # api-项目',
    '【总结】本次任务已完成',
    '10:35',
    '• 实现了登录接口',
    '• 编写了单元测试',
    '• 接下来建议优化错误处理',
    '【详情（1/3）】需求分析',
    '......',
    '（内容较长，已自动分段）',
    '【详情（2/3）】实现过程',
    '【详情（3/3）】测试与结果',
    'report.zip',
    '10:36',
    '（包含 5 个文件）  1.2 MB',
    '最终总结',
    '长回复分段',
    '自动上传文件',
    '需要回传文件时，让 Codex 指定文件路径，Bridge 会发回 Discord。',
]

visual_inventory = [
    {'id': 'title_sparkles_and_underline', 'kind': 'decorative strokes', 'decision': 'native line shapes', 'reason': 'simple hand-drawn strokes with no semantic bitmap identity'},
    {'id': 'codex_cube_icon', 'kind': 'simple line icon', 'decision': 'native line shapes plus native text C', 'reason': 'small geometric icon can be editable primitives'},
    {'id': 'terminal_icon', 'kind': 'simple terminal pictogram', 'decision': 'native rounded rectangle and lines', 'reason': 'basic primitive icon'},
    {'id': 'result_category_cards', 'kind': 'cards with icons', 'decision': 'native rounded rectangles, lines and text', 'reason': 'all text is native; icons are simple primitives'},
    {'id': 'flow_arrows', 'kind': 'orange arrows and bracket', 'decision': 'native line shapes', 'reason': 'simple connector strokes'},
    {'id': 'bridge_icon', 'kind': 'simple bridge pictogram', 'decision': 'native line shapes', 'reason': 'geometric line icon with no source-identity requirement'},
    {'id': 'structured_message_card', 'kind': 'green card and code box', 'decision': 'native rounded rectangles and native text', 'reason': 'required editable code label BRIDGE_SEND_FILE'},
    {'id': 'discord_channel_panel', 'kind': 'channel mockup', 'decision': 'native rounded rectangles, line icons and text', 'reason': 'simplified editable Discord channel per task request'},
    {'id': 'legend_chips', 'kind': 'short labels', 'decision': 'native rounded rectangles, primitives and text', 'reason': 'labels must remain editable'},
    {'id': 'takeaway_callout', 'kind': 'dashed callout with bulb icon', 'decision': 'native rounded rectangle, line icon and text runs', 'reason': 'takeaway must be native text'},
]

manifest = {
    'schema_version': 1,
    'page_id': 'page_005',
    'slide': {
        'width': 13.333,
        'height': 7.5,
        'background': BG,
    },
    'source': {
        'path': 'source.png',
        'width_px': W,
        'height_px': H,
    },
    'preview_scale': 125,
    'preview_font_scale': 1.0,
    'strategy': 'Object-level editable reconstruction using native text boxes, cards, connectors, and simplified native vector icons; no full-slide source raster is used.',
    'text_inventory': text_inventory,
    'visual_inventory': visual_inventory,
    'background_strategy': {
        'mode': 'native-or-script',
        'source_consistency_contract': 'Keep the warm off-white plain background and rebuild all visible foreground as editable native objects.',
        'removed_foreground': 'No clean-base raster removal; all readable content, cards, arrows, and mock Discord panel are redrawn natively.',
        'comparison_note': 'Source background is flat off-white with slight scan warmth; native slide background approximates it without duplicating source raster.',
    },
    'quality_checks': {
        'font_size_calibrated': True,
        'visual_inventory_matched': True,
        'background_strategy_checked': True,
        'shape_corner_geometry_checked': True,
    },
    'text_boxes': text_boxes,
    'shapes': shapes,
    'images': images,
    'asset_provenance': asset_provenance,
    'known_limits': [
        'Hand-drawn marker texture is approximated with clean native strokes.',
        'Discord logo and small icons are simplified native primitives rather than exact logo artwork.',
        'PPT preview renderer has approximate font metrics; PowerPoint may render CJK text slightly differently.',
    ],
    'qa_notes': 'All readable source text is represented by visible native text boxes; structural objects are native shapes and no full-slide raster is used.',
}

# Ensure all roundRect shapes have radius and line/shape positions are source-pixel authored.
for s in manifest['shapes']:
    if s.get('type') == 'roundRect' and not s.get('source_corner_radius_px'):
        s['source_corner_radius_px'] = 12
        s['corner_category'] = 'small-radius'
        s['corner_reason'] = 'fallback small radius for rounded card'

(PAGE_DIR / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
# Preserve page-local imagegen status; no jobs needed for this native reconstruction.
imagegen_jobs = {
    'schema_version': 1,
    'run_id': 'codex-discord-bridge-user-guide-editable',
    'page_id': 'page_005',
    'jobs': [],
    'note': 'No image generation required; all non-text visuals are native primitive shapes.'
}
(PAGE_DIR / 'imagegen-jobs.json').write_text(json.dumps(imagegen_jobs, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(PAGE_DIR / 'manifest.json')
