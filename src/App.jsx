import { useEffect, useState } from 'react'
import { Bug, FileText, Moon, Sun } from 'lucide-react'
import { useI18n } from './i18n.jsx'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import NetAnimViewer from './components/NetAnimViewer.jsx'

export const REPO_URL = 'https://github.com/faustinoaq/netanim-web'

// Bundled traces, so a first-time visitor sees the viewer working before they
// have an anim.xml of their own. Both come from ns-3 3.44 runs.
const EXAMPLES = [
  { key: 'csma', file: 'examples/csma-bus-10-nodes.xml' },
  { key: 'wifi', file: 'examples/wifi-adhoc-10-nodes.xml' },
]

// Lucide dropped brand marks, so the GitHub logo is drawn inline.
function GitHubMark({ className }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  )
}

function LangToggle() {
  const { lang, setLang } = useI18n()
  return (
    <div className="flex items-center overflow-hidden rounded-sm border border-rule-strong" role="group">
      {['es', 'en'].map((code) => (
        <button
          key={code}
          type="button"
          onClick={() => setLang(code)}
          aria-pressed={lang === code}
          className={`px-2 py-1.5 font-mono text-xs uppercase transition-colors ${
            lang === code
              ? 'bg-signal text-primary-foreground'
              : 'bg-panel text-ink-soft hover:text-ink'
          }`}
        >
          {code}
        </button>
      ))}
    </div>
  )
}

function ThemeToggle() {
  const { t } = useI18n()
  const [dark, setDark] = useState(() => document.documentElement.dataset.theme === 'dark')
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    localStorage.setItem('netanim-web-theme', dark ? 'dark' : 'light')
  }, [dark])
  return (
    <Button
      variant="outline"
      size="icon"
      aria-label={t('app.theme')}
      aria-pressed={dark}
      onClick={() => setDark((d) => !d)}
    >
      {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </Button>
  )
}

export default function App() {
  const { t } = useI18n()
  const [example, setExample] = useState(null)

  return (
    <div className="chassis min-h-screen">
      <div className="mx-auto max-w-[1400px] px-4 pt-6 pb-10 sm:px-5">
        <header className="mb-5 flex flex-wrap items-end justify-between gap-4 border-b border-rule pb-3">
          <div className="flex items-center gap-3">
            <img src="favicon.svg?v=2" alt="" className="size-10" />
            <div>
              <h1 className="nameplate text-[1.875rem] leading-none">{t('app.title')}</h1>
              <p className="mt-1.5 text-[0.8125rem] leading-none text-ink-soft">{t('app.tagline')}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" asChild>
              <a href={REPO_URL} target="_blank" rel="noreferrer">
                <GitHubMark className="size-4" />
                GitHub
              </a>
            </Button>
            <LangToggle />
            <ThemeToggle />
          </div>
        </header>

        <Card>
          <CardHeader>
            <CardTitle>NetAnim</CardTitle>
            <CardAction className="flex flex-wrap items-center gap-2">
              <span className="eyebrow">{t('app.examples')}</span>
              {EXAMPLES.map((ex) => (
                <Button
                  key={ex.key}
                  variant={example === ex.file ? 'default' : 'outline'}
                  size="xs"
                  onClick={() => setExample(ex.file)}
                >
                  <FileText className="size-3" />
                  {t(`app.example.${ex.key}`)}
                </Button>
              ))}
            </CardAction>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-xs leading-snug text-ink-soft">{t('anim.viewerDesc')}</p>
            {/* Keyed by the example so switching remounts the viewer: its clock,
                zoom and playback state belong to the trace being shown. */}
            <NetAnimViewer key={example ?? 'empty'} source={example} label={example?.split('/').pop()} />
          </CardContent>
        </Card>

        <footer className="mt-6 flex flex-wrap items-start justify-between gap-4 border-t border-rule pt-3 text-xs text-ink-soft">
          <div className="max-w-2xl space-y-1">
            <p>{t('app.footer')}</p>
            <p>
              {t('app.origin').split('SSBCV').map((part, i) =>
                i === 0 ? part : (
                  <span key={i}>
                    <a className="underline underline-offset-2 hover:text-ink" href="https://github.com/faustinoaq/ssbcv" target="_blank" rel="noreferrer">SSBCV</a>
                    {part}
                  </span>
                ),
              )}
            </p>
          </div>
          <div className="flex flex-wrap gap-4">
            <a className="inline-flex items-center gap-1.5 hover:text-ink" href={REPO_URL} target="_blank" rel="noreferrer">
              <GitHubMark className="size-3.5" />
              {t('app.github')}
            </a>
            <a className="inline-flex items-center gap-1.5 hover:text-ink" href={`${REPO_URL}/issues`} target="_blank" rel="noreferrer">
              <Bug className="size-3.5" />
              {t('app.issues')}
            </a>
          </div>
        </footer>
      </div>
    </div>
  )
}
