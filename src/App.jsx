import React, { useEffect, useRef, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

export default function App(){
  const [chat, setChat] = useState([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const scrollerRef = useRef(null)

  useEffect(() => { scrollerRef.current?.scrollTo(0, 9_999_999) }, [chat])

  // bootstrap – pošli syntetického usera
  useEffect(() => {
    if (chat.length > 0) return
    const bootstrap = async () => {
      setLoading(true)
      const firstMessages = [{ role: 'user', content: 'Hello' }]
      try{
        const r = await fetch('/.netlify/functions/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: firstMessages })
        })
        let data
        try {
          data = await r.json()
        } catch {
          const txt = await r.text()
          data = { reply: txt || '⚠️ Bad response' }
        }
        setChat([{ role: 'assistant', content: data.reply }])
      }catch(e){
        console.error('bootstrap error', e)
        setChat([{ role: 'assistant', content: '⚠️ Nelze se připojit k serveru. Zkuste prosím znovu.' }])
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
      // NEHÁZEJ při !r.ok – vždy se snaž zobrazit, co přišlo
      let data
      try {
        data = await r.json()
      } catch {
        const txt = await r.text()
        data = { reply: txt || `⚠️ Server returned status ${r.status}` }
      }
      setChat([...next, { role: 'assistant', content: data.reply }])
    }catch(e){
      console.error('send error', e)
      setChat([...next, { role: 'assistant', content: '⚠️ Nelze se připojit k serveru. Zkuste to prosím znovu.' }])
    }finally{
      setLoading(false)
    }
  }

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
