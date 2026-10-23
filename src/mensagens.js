import { supabase } from './supabase.js'

// Guarda (ou atualiza, se foi editada) uma mensagem de texto de um grupo
// acompanhado, pro /resumo.
export async function guardarMensagem({ groupJid, topico, msgId, jidAutor, apelido, texto }) {
  const limpo = String(texto || '').trim()
  if (!limpo) return
  const { error } = await supabase.from('whatsapp_mensagens').upsert(
    {
      group_jid: groupJid,
      topico,
      msg_id: msgId,
      jid_autor: jidAutor,
      apelido: apelido || 'alguém',
      texto: limpo.slice(0, 2000),
      tem_spoiler: false,
    },
    { onConflict: 'group_jid,msg_id' }
  )
  if (error) console.error('guardarMensagem:', error.message)
}

// Apaga mensagens guardadas que já passaram da retenção de cada tópico
// (mesmos prazos do Telegram: 10 dias bate-papo, 30 dias o resto).
export async function limparMensagensAntigas() {
  const DIA_MS = 24 * 60 * 60 * 1000
  const cortes = { bate_papo: 10, leitura: 30, avisos: 30, presencial: 30 }
  for (const [topico, dias] of Object.entries(cortes)) {
    const limite = new Date(Date.now() - dias * DIA_MS).toISOString()
    const { error } = await supabase.from('whatsapp_mensagens').delete().eq('topico', topico).lt('criado_em', limite)
    if (error) console.error(`limparMensagensAntigas ${topico}:`, error.message)
  }
}
