// Memória curta de conversa por jid (em memória, zera se o bot reiniciar):
// guarda as últimas trocas pra respostas curtas tipo "onde?" ou "e amanhã?"
// conseguirem entender o que a pergunta anterior já tinha estabelecido.
const VALIDADE_MIN = 15
const MAX_TROCAS = 4

const porJid = new Map()

export function pegarHistorico(jid) {
  const h = porJid.get(jid)
  if (!h) return []
  if (Date.now() - h.atualizadoEm > VALIDADE_MIN * 60_000) {
    porJid.delete(jid)
    return []
  }
  return h.mensagens
}

export function guardarTroca(jid, pergunta, resposta) {
  const h = porJid.get(jid) || { mensagens: [] }
  h.mensagens.push({ role: 'user', content: pergunta }, { role: 'assistant', content: resposta })
  if (h.mensagens.length > MAX_TROCAS * 2) h.mensagens = h.mensagens.slice(-MAX_TROCAS * 2)
  h.atualizadoEm = Date.now()
  porJid.set(jid, h)
}
