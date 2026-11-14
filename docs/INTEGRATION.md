# Интеграция 3D-части (Участник 1) в репозиторий команды

Состояние на 14.11.2026. Ветка `feature/3d-moon` ещё **без коммитов** и создана не от `origin/main`,
поэтому прямое слияние перезапишет файлы команды. Ниже — безопасный порядок. Файлы команды
в этой ветке не менялись.

## 1. Какие файлы мои (переносятся как есть)

| Путь | Что |
|---|---|
| `src/scene/**` | `MoonScene` и все модули 3D |
| `src/main.js`, `src/models-page.js` | обвязка dev-страниц |
| `3d.html`, `models.html` | dev-консоль 3D и витрина моделей (не `index.html` — он у команды) |
| `scripts/**` | препроцессинг NASA-данных, Blender-скрипты |
| `public/textures/**`, `public/models/**`, `public/data/polar/**`, `public/fallback/**` | ассеты 3D |
| `public/data/ephem_subpoints.json` | подсолнечные/подземные точки из JPL Horizons (отдельное имя: `ephem.json` у команды другого формата) |
| `tests/**` | проверки научных расчётов (`node --test`) |
| `docs/**`, `assets/blender/**` | отчёты, скриншоты, исходники `.blend` |

## 2. Конфликтующие файлы — решает команда

| Файл | У команды | У меня | Предложение |
|---|---|---|---|
| `package.json` | React 19, Vite 6, Tailwind | `three@0.187`, Vite 8 | добавить в их файл зависимость `three` (Vite 6 тоже подходит) и скрипт `"test": "node --test tests/"` |
| `vite.config.js` | плагины React/Tailwind | страницы `3d.html`, `models.html` | добавить мои страницы в `build.rollupOptions.input` их конфига |
| `index.html`, `README.md`, `.gitignore` | их | мои | оставить их; из моего `.gitignore` добавить `data_raw/`, `scripts/.venv/` |
| `public/data/sites.json` | канон Участника 2 | копия того же файла | оставить их |

## 3. Порядок переноса (без потери истории команды)

```bash
git fetch origin
git switch -c feature/3d-moon-integration origin/main
# скопировать файлы из раздела 1 (не трогая раздел 2), затем:
git add src/scene src/main.js src/models-page.js 3d.html models.html scripts tests docs public/textures public/models public/data/polar public/fallback public/data/ephem_subpoints.json
```

## 4. Подключение в React (`src/components/MoonScene.jsx` — файл команды)

Заглушка команды помечена «PLACEHOLDER for participant 1's Three.js scene». Обёртка над классом:

```jsx
import { useEffect, useRef } from 'react'
import { MoonScene } from '../scene/MoonScene.js'
import { useStore } from '../store.js'

export default function MoonSceneView() {
  const ref = useRef(null)
  const moon = useRef(null)
  const { sites, selectedId, time, select } = useStore()

  useEffect(() => {
    const m = new MoonScene(ref.current, { hud: true })
    moon.current = m
    fetch('/data/ephem_subpoints.json').then((r) => r.json()).then((e) => m.setEphemeris(e.rows))
    const off = m.on('siteclick', ({ id }) => select(id))
    return () => { off(); m.dispose() }
  }, [])
  useEffect(() => { moon.current?.setSites(sites) }, [sites])
  useEffect(() => { moon.current?.select(selectedId) }, [selectedId])
  useEffect(() => { moon.current?.setDate(new Date(time)) }, [time])

  return <div ref={ref} style={{ position: 'relative', width: '100%', height: '100%' }} />
}
```

API сцены — в `README.md` (раздел «API 3D-сцены»). Все методы и события первой версии сохранены.
