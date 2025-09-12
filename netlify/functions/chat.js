// netlify/functions/chat.js
export default async (req) => {
  try {
    if (req.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    let body = {};
    try {
      body = await req.json();
    } catch {
      return new Response('Bad JSON body', { status: 400 });
    }
    const { messages = [] } = body;

    // --- Hotel config + lokální fotky v /public/img ---
    // Do složky public/img přidej své fotky (viz níže). Tyto názvy můžeš nechat a jen soubory vyměnit.
    const HOTEL = {
      name: 'CHILL Apartments', city: 'Prague',
      checkIn: '14:00', checkOut: '11:00',
      gateCode: '3142#', luggageCode: '3142#',
      boxes: { 1:'1421#',2:'1432#',3:'1443#',4:'1454#',5:'1465#',6:'1476#',8:'2432#',9:'2443#',10:'2454#',11:'2465#' },
      disabledBoxes: [7, 12],
      parking: { totalSpots: 4, priceEurPerNight: 20, alt: 'https://www.mrparkit.com' },
      taxi: { small: 31, large: 42 },
      links: {
        matterport: 'https://my.matterport.com/show/?m=PTEAUeUbMno',
        photos: {
          gate: '/img/gate.jpg',
          luggage: '/img/luggage.jpg',
          keybox: '/img/keybox.jpg',
          sensor: '/img/sensor.jpg',
          parking_entry: '/img/parking-entry.jpg'
        }
      },
      wifi: [
        { apartment: '202', floor: 2, ssid: 'CHILL-202', pass: '***' },
        { apartment: '203', floor: 2, ssid: 'CHILL-203', pass: '***' }
      ]
    };

    const systemPrompt = `You are a hotel assistant for ${HOTEL.name} in ${HOTEL.city}.
- Always reply in the user's language if possible.
- Check-in from ${HOTEL.checkIn}, check-out by ${HOTEL.checkOut}.
- Gate & luggage room code: ${HOTEL.gateCode}.
- Key boxes: ${Object.entries(HOTEL.boxes).map(([n,c])=>`#${n}=${c}`).join(', ')}. Boxes 7 and 12 are disabled; never assign them.
- Parking: ${HOTEL.parking.totalSpots} spaces total; price ${HOTEL.parking.priceEurPerNight} €/night. If full, offer ${HOTEL.parking.alt} and optional waitlist.
- Taxi: small up to 4p = ${HOTEL.taxi.small} €, large 5–8p or lots of luggage = ${HOTEL.taxi.large} €; request flight number and landing time.
- TV is Smart TV with no channels. AC: Sun=heat, Snowflake=cool. No smoking (100 € fine). No open fire.
- Wi-Fi is per-apartment. If guest doesn't see the SSID, suggest alternates from the list.
- For self check-in/out and parking, respond as short HTML with an ordered list <ol>. After each step, when a relevant photo URL exists, include <img src="...">.
- Preferred photo mapping: "Open gate" -> photos.gate; "Luggage room" -> photos.luggage; "Key box" -> photos.keybox; "Use chip/sensor" -> photos.sensor; "Parking entry" -> photos.parking_entry.
- Keep replies concise and friendly.`;

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) {
      return new Response('Missing OPENAI_API_KEY env var', { status: 500 });
    }

    // spolehlivý model pro /v1/chat/completions
    const model = 'gpt-4o-mini';

    const payload = {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'system', content: `Hotel data JSON: ${JSON.stringify(HOTEL)}` },
        ...messages
      ],
      temperature: 0.2
    };

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!r.ok) {
      const txt = await r.text();
      return new Response(`Upstream OpenAI error (${r.status}): ${txt}`, {
        status: 502,
        headers: { 'content-type': 'text/plain' }
      });
    }

    const data = await r.json();
    const reply = data.choices?.[0]?.message?.content || 'Sorry, no reply.';
    return new Response(JSON.stringify({ reply }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });

  } catch (err) {
    return new Response(`Function error: ${String(err)}`, {
      status: 500,
      headers: { 'content-type': 'text/plain' }
    });
  }
};
