import React, { useEffect, useRef, useState } from 'react'

export default function App(){
  const [chat, setChat] = useState([
    { role: 'assistant', content: 'Hello! I\'m the CHILL Apartments assistant. How can I help you today?' }
  ])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const scrollerRef = useRef(null)

  useEffect(() => { scrollerRef.current?.scrollTo(0, 9999999) }, [chat])

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
      setChat([...next, { role: 'assistant', content: 'Sorry, something went wrong.' }])
      console.error(e)
    }finally{
      setLoading(false)
    }
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
              ? <div key={i} className="bubble a" dangerouslySetInnerHTML={{ __html: m.content }} />
              : <div key={i} className="bubble u">{m.content}</div>
          ))}
          {loading && <div className="bubble a">…</div>}
        </div>

        <div className="flex gap-2 mt-3">
          <input
            className="flex-1 input"
            placeholder="Type here (any language)…"
            value={input}
            onChange={e=>setInput(e.target.value)}
            onKeyDown={e=> e.key==='Enter' && send()}
          />
          <button className="btn" onClick={send} disabled={loading}>Send</button>
        </div>

        <footer className="mt-4 text-xs opacity-60">
          Tip: You can paste your booking link to get tailored instructions.
        </footer>
      </div>
    </div>
  )
}
