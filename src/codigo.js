import { supabase } from './supabase.js'
import { CODIGO_SECRET } from './config.js'

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
    text: `🔑 Código para acessar o site de membras (https://membrosfarol.vercel.app/): ${config.codigo_atual} 💕`,
  })

  await supabase.from('bot_config').update({ codigo_postado_whatsapp_em: new Date().toISOString() }).eq('id', 1)
}

// !novocodigo (admin, dentro do grupo Avisos): pede a troca na hora. Quem
// posta o código novo é o checarCodigoPendente, logo em seguida.
export async function pedirNovoCodigo() {
  if (!CODIGO_SECRET) return 'CODIGO_SECRET não configurado no .env.'
  const r = await fetch('https://bxufxzbqppysvxxifhhm.supabase.co/functions/v1/trocar-codigo-whatsapp', {
    method: 'POST',
    headers: { 'x-cron-secret': CODIGO_SECRET },
  })
  const json = await r.json().catch(() => null)
  if (!r.ok) return json?.error || 'Não foi possível trocar o código agora.'
  return null
}
