import React, { useEffect, useRef, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

export default function App(){
  const [chat, setChat] = useState([
    {
      role: 'assistant',
      content: [
        'Vítejte v **CHILL Apartments**! ✨',
        '',
        'Abych vám mohl co nejlépe pomoci, napište prosím:',
        '- **Datum a čas příjezdu** (např. 28.09.2025 18:30)',
        '- zda potřebujete **parkování**',
        '- zda chcete **taxi** z/na letiště',
        '',
        '**Self check-in**',
        '- Kód do boxu a **číslo apartmánu pošle David** před příjezdem.',
        '',
        '**Úschova zavazadel**',
        '- Příjezd **před 14:00** – můžete uložit zavazadla do **bagážovny**.',
        '- Po **check-outu (11:00)** – můžete uložit věci v **bagážovně**.',
        '',
        '_Fotky příjezdu/parkování přidáme sem později._'
      ].join('\n')
    }
  ])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const scrollerRef = useRef(null)

  // scroll na konec po každé změně chatu
  useEffect(() => { scrollerRef.current?.scrollTo(0, 9_999_999) }, [chat])

  async function send(){
    if(!input.trim()) return
    const next = [...chat, { role: 'user', content: input }]
    setChat(next); setInput(''); setLoading(true)
    try{
      const r = await fetch('/.netlify/functions/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: next })
      })
      if(!r.ok){
        const txt = await r.text()
        throw new Error(txt || `HTTP ${r.status}`)
      }
      const data = await r.json()
      setChat([...next, { role: 'assistant', content: data.reply }])
    }catch(e){
      setChat([...next, { role: 'assistant', content: 'Omlouvám se, něco se pokazilo. Zkuste to prosím znovu.' }])
      console.error(e)
    }finally{
      setLoading(false)
    }
  }

  // převod Markdown → bezpečné HTML
  function renderAssistant(md = ''){
    // povol řádkové zlomy jako <br>, lepší čtení
    const rawHtml = marked.parse(md, { breaks: true })
    // očistit XSS
    const safeHtml = DOMPurify.sanitize(rawHtml)
    return { __html: safeHtml }
  }

  return (
    <div className="min-h-screen p-4 flex flex-col items-center bg-zinc-100">
      <div className="w-full max-w-2xl bg-white rounded-2xl shadow p-4">
        <header className="mb-3">
          <h1 className="text-2xl font-semibold">CHILL Assistant</h1>
          <p className="text-sm opacity-70">Speaks your language • 24/7 • Check-in, parking, Wi-Fi, airport transfer</p>
        </header>

        <div ref={scrollerRef} className="chatbox">
          {chat.map((m, i) => (
            m.role === 'assistant'
              ? <div key={i} className="bubble a prose" dangerouslySetInnerHTML={renderAssistant(m.content)} />
              : <div key={i} className="bubble u">{m.content}</div>
          ))}
          {loading && <div className="bubble a">…</div>}
        </div>

        <div className="flex gap-2 mt-3">
          <input
            className="flex-1 input"
            placeholder="Napište datum a čas příjezdu, parkování a/nebo taxi…"
            value={input}
            onChange={e=>setInput(e.target.value)}
            onKeyDown={e=> e.key==='Enter' && send()}
          />
          <button className="btn" onClick={send} disabled={loading}>Send</button>
        </div>

        <footer className="mt-4 text-xs opacity-60">
          Tip: Můžete vložit i odkaz na rezervaci — připravím instrukce na míru.
        </footer>
      </div>
    </div>
  )
}
