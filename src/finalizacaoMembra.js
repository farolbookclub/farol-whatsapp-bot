import { supabase } from './supabase.js'
import { enviarMsg } from './envio.js'
import { avisarInstagramEntrou } from './instagramAviso.js'
import { avisarAdminEntrouSaiu } from './pushAdmin.js'
import { nomeExibicaoDoSignup } from './vinculo.js'

// Manda o código sempre em 2 mensagens: uma com o contexto/link, outra só
// com o código em si (sem mais nada), pra facilitar copiar e colar.
export async function enviarCodigoEmDuasMensagens(sock, jid, codigo, textoIntro) {
  await enviarMsg(sock, jid, { text: `${textoIntro}\nhttps://membrosfarol.vercel.app/` })
  await enviarMsg(sock, jid, { text: `*${codigo}*` })
}

async function avisarInstagramSeTiver(sock, signupId) {
  const { data: s } = await supabase.from('signups').select('apelido, nome, instagram').eq('id', signupId).maybeSingle()
  if (!s) return
  await avisarInstagramEntrou(sock, signupId, s.apelido || s.nome, s.instagram)
}

// Avisa a admin que "entrou oficialmente" só aqui, 1x só — guardado pelo
// mesmo codigo_enviado que o resto dessa função.
async function avisarAdminEntrouOficial(signupId, formato) {
  const { data: s } = await supabase.from('signups').select('apelido, nome').eq('id', signupId).maybeSingle()
  const nome = await nomeExibicaoDoSignup(signupId, s?.apelido || s?.nome || 'Alguém')
  await avisarAdminEntrouSaiu('entrou', { apelido: nome, formato })
}

// Conclui a entrada oficial de uma integrante (manda boas-vindas + código,
// avisa Instagram e a admin) — só 1x por pessoa, guardado por
// whatsapp_membros.codigo_enviado. Chamado tanto de quando o bot detecta
// que ela entrou de fato no último grupo que faltava (codigo.js) quanto de
// quando ela termina o guia e já estava em todos os grupos (guia.js) — os
// dois caminhos levam ao mesmo lugar, sem duplicar o envio.
export async function concluirEntradaOficial(sock, jid, signupId, formato) {
  if (!signupId) return false
  const { data: membro } = await supabase.from('whatsapp_membros').select('codigo_enviado').eq('jid', jid).maybeSingle()
  if (!membro || membro.codigo_enviado) return false

  const { data: config } = await supabase.from('bot_config').select('codigo_atual').eq('id', 1).maybeSingle()
  if (!config?.codigo_atual) return false

  try {
    await enviarMsg(sock, jid, { text: 'Pronto, agora você faz parte do Farol! 🎀 Seja muito bem-vinda 💖' })
    await enviarCodigoEmDuasMensagens(sock, jid, config.codigo_atual, 'Este é o seu código de membra. Guarde, porque você vai usar no site:')
    await supabase.from('whatsapp_membros').update({ codigo_enviado: true }).eq('jid', jid)
    await avisarInstagramSeTiver(sock, signupId)
    await avisarAdminEntrouOficial(signupId, formato)
    return true
  } catch (erro) {
    console.error(`concluirEntradaOficial ${jid}:`, erro)
    return false
  }
}
