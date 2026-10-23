import { PUSH_SECRET } from './config.js'

// Avisa a Administração (push no celular dela, mesma função que já existe
// pro Telegram) quando alguém entra ou sai de um grupo do WhatsApp direto
// (sem passar pelo painel admin, que já tem seus próprios avisos na tela).
export async function avisarAdminEntrouSaiu(tipo, dados) {
  if (!PUSH_SECRET) return
  try {
    const r = await fetch('https://bxufxzbqppysvxxifhhm.supabase.co/functions/v1/notify-admin-push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-webhook-secret': PUSH_SECRET },
      body: JSON.stringify({ tipo, ...dados }),
    })
    if (!r.ok) console.error('avisarAdminEntrouSaiu:', await r.text().catch(() => r.status))
  } catch (erro) {
    console.error('avisarAdminEntrouSaiu:', erro)
  }
}
