# Run from the player root after copying the JSON works into data/.
from pathlib import Path
import json
folder = Path(__file__).resolve().parent / 'data'
works = []
for file in sorted(folder.glob('*.json')):
    if file.name == 'works.json': continue
    # Unicode filenames, including Hebrew, are supported.
    try:
        data = json.loads(file.read_text(encoding='utf-8-sig'))
        if not isinstance(data.get('segments'), dict): continue
        works.append({'id':file.stem, 'title':data.get('libraryTitle') or file.stem})
    except (ValueError, OSError, AttributeError) as error:
        print('Skipped:', file.name, error)
(folder/'works.json').write_text(json.dumps({'works':works},ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(f'Indexed {len(works)} works in {folder / "works.json"}')
