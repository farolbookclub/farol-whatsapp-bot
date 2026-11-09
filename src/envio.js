import { supabase } from './supabase.js'

// Envia e guarda o "key" da mensagem (jid, msg_id), pra dar pra apagar
// depois se precisar (ex.: mensagem mandada por engano). Guarda só por
// alguns dias (limparEnviosAntigos), nada de ficar acumulando pra sempre.
export async function enviarMsg(sock, jid, conteudo, opcoes) {
  const resultado = await sock.sendMessage(jid, conteudo, opcoes)
  const msgId = resultado?.key?.id
  if (msgId) {
    supabase
      .from('whatsapp_mensagens_enviadas')
      .insert({ jid, msg_id: msgId })
      .then(({ error }) => {
        if (error) console.error('guardar key de mensagem enviada:', error.message)
      })
  }
  return resultado
}

// Apaga (pra todo mundo) uma mensagem que o bot mandou, pelo jid + msg_id
// guardados. Só funciona dentro da janela que o WhatsApp permite apagar.
export async function apagarMsgEnviada(sock, jid, msgId) {
  await sock.sendMessage(jid, { delete: { remoteJid: jid, id: msgId, fromMe: true } })
}

// Retenção de 3 dias (a janela de "apagar pra todo mundo" do WhatsApp é
// bem menor que isso) — roda junto com a limpeza diária de mensagens.
export async function limparEnviosAntigos() {
  const limite = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()
  const { error } = await supabase.from('whatsapp_mensagens_enviadas').delete().lt('criado_em', limite)
  if (error) console.error('limparEnviosAntigos:', error.message)
}
