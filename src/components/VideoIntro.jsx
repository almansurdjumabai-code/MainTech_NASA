// Cinematic intro: Blender-rendered clip (public/intro/intro.mp4, 6 s @ 50 fps) —
// the shuttle stack crosses golden-hour clouds and the 3D "MainTech" title emerges
// from its exhaust (the title is part of the video). Falls back to the SVG intro
// if the video can't play (missing file, autoplay blocked, reduced motion).
import { useEffect, useRef, useState } from 'react'
import { useT } from '../lib/i18n.js'
import { SvgIntro } from './Intro.jsx'

const FADE_AT = 5.55  // s — whole intro fades out
const END_AT = 6.1    // s — hand over to the site

export default function Intro({ onDone }) {
  const t = useT()
  const vid = useRef(null)
  const [mode, setMode] = useState(() =>
    typeof window !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches ? 'svg' : 'video')
  const [fading, setFading] = useState(false)
  const done = useRef(false)
  const finish = () => { if (!done.current) { done.current = true; onDone() } }

  useEffect(() => {
    if (mode !== 'video') return
    const v = vid.current
    // if playback hasn't started shortly, fall back to the SVG intro
    const startGuard = setTimeout(() => { if (!v || v.currentTime < 0.05) setMode('svg') }, 1500)
    const hardStop = setTimeout(finish, (END_AT + 2) * 1000) // never hang
    // sync on video time; interval + timeupdate keep working even when rAF is throttled
    const sync = () => {
      const tt = v?.currentTime ?? 0
      if (tt >= FADE_AT) setFading(true)
    }
    const iv = setInterval(sync, 50)
    const onEnded = () => { setFading(true); setTimeout(finish, 500) }
    v?.addEventListener('timeupdate', sync)
    v?.addEventListener('ended', onEnded)
    v?.play?.().catch(() => setMode('svg'))
    return () => { clearInterval(iv); clearTimeout(startGuard); clearTimeout(hardStop); v?.removeEventListener('timeupdate', sync); v?.removeEventListener('ended', onEnded) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])

  if (mode === 'svg') return <SvgIntro onDone={onDone} />

  const skip = () => { setFading(true); setTimeout(finish, 350) }
  return (
    <div onClick={skip} role="presentation"
      className="fixed inset-0 z-50 bg-black cursor-pointer overflow-hidden transition-opacity duration-500"
      style={{ opacity: fading ? 0 : 1 }}>
      <video ref={vid} src="/intro/intro.mp4" muted playsInline autoPlay preload="auto"
        onError={() => setMode('svg')}
        className="absolute inset-0 w-full h-full object-cover" />
      <div className="absolute bottom-6 inset-x-0 text-center label !text-[9px] opacity-60">{t('skip')}</div>
    </div>
  )
}
