import { PUSH_SECRET } from './config.js'

// Avisa a Administração (push no celular dela, mesma função que já existe
// pro Telegram) quando alguém entra ou sai de um grupo do WhatsApp direto
// (sem passar pelo painel admin, que já tem seus próprios avisos na tela).
async function chamarNotifyAdminPush(corpo) {
  if (!PUSH_SECRET) return
  try {
    const r = await fetch('https://bxufxzbqppysvxxifhhm.supabase.co/functions/v1/notify-admin-push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-webhook-secret': PUSH_SECRET },
      body: JSON.stringify(corpo),
    })
    if (!r.ok) console.error('notify-admin-push:', await r.text().catch(() => r.status))
  } catch (erro) {
    console.error('notify-admin-push:', erro)
  }
}

export async function avisarAdminEntrouSaiu(tipo, dados) {
  await chamarNotifyAdminPush({ tipo, ...dados })
}

// Erro de verdade (bug) no Faroleiro: avisa a Administração, igual o
// Telegram já faz. Com um intervalo mínimo entre avisos pra não floodar o
// celular dela se o mesmo erro ficar se repetindo (ex: numa reconexão).
let ultimoAvisoErroEm = 0
const INTERVALO_MIN_ERRO_MS = 2 * 60 * 1000

export async function avisarAdminErro(mensagem) {
  const agora = Date.now()
  if (agora - ultimoAvisoErroEm < INTERVALO_MIN_ERRO_MS) return
  ultimoAvisoErroEm = agora
  await chamarNotifyAdminPush({ tipo: 'erro', mensagem: String(mensagem || 'erro sem detalhe').slice(0, 200) })
}
