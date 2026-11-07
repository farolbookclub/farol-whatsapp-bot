import { supabase } from './supabase.js'
import { gruposParaEnviar, grupoTemMembro } from './guia.js'

// Confere se o código do site mudou (rotação automática semanal ou pedido
// manual) e ainda não foi postado no Avisos do WhatsApp; posta se precisar.
export async function checarCodigoPendente(sock) {
  const { data: config } = await supabase
    .from('bot_config')
    .select('codigo_atual, codigo_trocado_em, codigo_postado_whatsapp_em')
    .eq('id', 1)
    .single()
  if (!config?.codigo_atual || !config.codigo_trocado_em) return

  const jaPostado = config.codigo_postado_whatsapp_em && new Date(config.codigo_postado_whatsapp_em) >= new Date(config.codigo_trocado_em)
  if (jaPostado) return

  const { data: grupo } = await supabase.from('whatsapp_grupos').select('group_jid').eq('topico', 'avisos').eq('ativo', true).maybeSingle()
  if (!grupo) return

  await sock.sendMessage(grupo.group_jid, {
    text: `🔑 Código do site de membras:\n*${config.codigo_atual}*\nhttps://membrosfarol.vercel.app/`,
  })

  await supabase.from('bot_config').update({ codigo_postado_whatsapp_em: new Date().toISOString() }).eq('id', 1)
}

// Depois que ela está de fato em todos os grupos do formato dela (Avisos,
// Bate-papo, Leitura do mês, +Presencial se for o caso), manda o código
// atual no privado — só 1 vez (whatsapp_membros.codigo_enviado). Chamado
// toda vez que ela entra em mais um grupo; só manda quando falta nenhum.
export async function checarEnviarCodigoSeCompleta(sock, jid, signupId, formato) {
  if (!signupId) return
  const { data: membro } = await supabase
    .from('whatsapp_membros')
    .select('codigo_enviado')
    .eq('jid', jid)
    .is('removido_em', null)
    .maybeSingle()
  if (!membro || membro.codigo_enviado) return

  const grupos = await gruposParaEnviar(formato)
  if (!grupos.length) return
  for (const g of grupos) {
    if (!(await grupoTemMembro(sock, g.group_jid, jid))) return // ainda falta algum
  }

  const { data: config } = await supabase.from('bot_config').select('codigo_atual').eq('id', 1).maybeSingle()
  if (!config?.codigo_atual) return

  try {
    await sock.sendMessage(jid, { text: `🔑 Código do site de membras:\n*${config.codigo_atual}*\nhttps://membrosfarol.vercel.app/` })
    await supabase.from('whatsapp_membros').update({ codigo_enviado: true }).eq('jid', jid)
  } catch (erro) {
    console.error(`enviar código ${jid}:`, erro)
  }
}
