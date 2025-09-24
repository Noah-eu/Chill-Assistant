import React, { useEffect, useRef, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

export default function App(){
  // Začínáme BEZ statické uvítací bubliny
  const [chat, setChat] = useState([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const scrollerRef = useRef(null)

  // scroll na konec po každé změně chatu
  useEffect(() => { scrollerRef.current?.scrollTo(0, 9_999_999) }, [chat])

  // === AUTO-ONBOARDING ===
  // Po načtení appky pošli syntetickou první USER zprávu,
  // tím backend vrátí správný onboarding (CZ/EN dle vzorku).
  useEffect(() => {
    // pokud už něco v chatu je, nic nedělej (obnova stránky apod.)
    if (chat.length > 0) return
    const bootstrap = async () => {
      setLoading(true)
      const firstMessages = [{ role: 'user', content: 'Hello' }] // CZ vzorek pro překlad
      try{
        const r = await fetch('/.netlify/functions/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: firstMessages })
        })
        if(!r.ok){
          const txt = await r.text()
          throw new Error(txt || `HTTP ${r.status}`)
        }
        const data = await r.json()
        setChat([{ role: 'assistant', content: data.reply }])
      }catch(e){
        console.error(e)
        setChat([{ role: 'assistant', content: 'Omlouvám se, něco se pokazilo při načítání. Zkuste to prosím znovu.' }])
      }finally{
        setLoading(false)
      }
    }
    bootstrap()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
      console.error(e)
      setChat([...next, { role: 'assistant', content: 'Omlouvám se, něco se pokazilo. Zkuste to prosím znovu.' }])
    }finally{
      setLoading(false)
    }
  }

  // převod Markdown → bezpečné HTML
  function renderAssistant(md = ''){
    const rawHtml = marked.parse(md, { breaks: true })
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
