import { SUPABASE_URL } from './config.js'

// Dispara a postagem automática no Story do Instagram do clube (feita pela
// Edge Function post-aniversario-instagram), no mesmo momento em que o bot
// já manda os parabéns no WhatsApp. Só mais uma chamada de rede, igual o
// bot já faz com a notify-admin-push — se der qualquer erro (token do
// Instagram ainda não configurado, Instagram fora do ar, etc.), só loga e
// segue a vida: nunca afeta a mensagem de parabéns do WhatsApp, que já foi
// enviada antes dessa chamada.
const ENDPOINT = `${SUPABASE_URL}/functions/v1/post-aniversario-instagram`

async function chamarPostInstagram(corpo) {
  try {
    const r = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(corpo),
    })
    if (!r.ok) console.error('post-aniversario-instagram:', await r.text().catch(() => r.status))
  } catch (erro) {
    console.error('post-aniversario-instagram:', erro)
  }
}

export async function postarAniversarioInstagram(signupId) {
  if (!signupId) return
  await chamarPostInstagram({ signup_id: signupId, tipo: 'pessoal' })
}

export async function postarTempoClubeInstagram(signupId, marco) {
  if (!signupId) return
  await chamarPostInstagram({ signup_id: signupId, tipo: 'clube', tempo_texto: `${marco} de Farol!` })
}
