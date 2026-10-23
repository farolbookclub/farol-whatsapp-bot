import { supabase } from './supabase.js'
import { GROQ_API_KEY } from './config.js'

const DIA_MS = 24 * 60 * 60 * 1000
const RETENCAO_DIAS = { bate_papo: 10, leitura: 30, avisos: 30, presencial: 30 }
const NOME_TOPICO = { bate_papo: 'Bate-papo', leitura: 'Leitura do mês', avisos: 'Avisos', presencial: 'Presencial' }

async function modeloIA() {
  const { data } = await supabase.from('bot_config').select('ia_modelo').eq('id', 1).single()
  return data?.ia_modelo || 'openai/gpt-oss-20b'
}

async function chamarGroq(promptSistema, conteudo, maxTokens) {
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GROQ_API_KEY}` },
    body: JSON.stringify({
      model: await modeloIA(),
      temperature: 0.3,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: promptSistema },
        { role: 'user', content: conteudo },
      ],
    }),
  })
  const json = await r.json().catch(() => null)
  const resposta = String(json?.choices?.[0]?.message?.content || '').trim()
  if (!r.ok || !resposta) console.error('Groq resumo:', r.status, JSON.stringify(json?.error ?? json))
  return resposta
}

const PROMPT_BASE =
  'Você resume conversas de um clube do livro (Farol Book Club), em português, tom caloroso. ' +
  'Seja CONCRETO: cite os assuntos, nomes de livros, links, códigos, datas e decisões realmente mencionados nas mensagens — ' +
  'nunca escreva algo vago tipo "o clima está leve" ou "a conversa foi descontraída" sem dizer sobre o quê. ' +
  'Se não der pra ser específico porque as mensagens são curtas ou só risadas, diga isso em uma frase, sem enfeitar. ' +
  'Nunca aponte quem não recebeu resposta, quem ficou quieta, ou qualquer coisa que possa soar como cobrança ou constranger alguém.'

function promptResumo(topico) {
  if (topico === 'leitura') {
    return PROMPT_BASE +
      ' Esse tópico é sobre a leitura do mês: cite reações concretas ao livro (gostaram, odiaram, abandonaram, dúvidas, comparações com outros livros), sem citar enredo. ' +
      'NUNCA revele detalhes de enredo, trama, reviravoltas ou qualquer coisa que possa ser spoiler — nem pistas sutis.'
  }
  if (topico === 'avisos') {
    return PROMPT_BASE +
      ' Esse tópico é de avisos oficiais da Administração: liste os avisos e novidades reais (códigos, links, prazos, parcerias, cupons, enquetes) de forma objetiva, como uma lista corrida, sem floreio.'
  }
  return PROMPT_BASE + ' Esse tópico é bate-papo livre do grupo: cite os assuntos de fato debatidos, não só o clima.'
}

// Gera o resumo de um tópico pra uma pessoa e manda no privado dela (jid).
export async function gerarEEnviarResumo(sock, jid, topico) {
  const agora = new Date()
  const limiteRetencao = new Date(agora.getTime() - RETENCAO_DIAS[topico] * DIA_MS)

  const { data: acesso } = await supabase
    .from('whatsapp_resumo_ultimo_acesso')
    .select('ultimo_em')
    .eq('jid', jid)
    .eq('topico', topico)
    .maybeSingle()

  let desde = acesso?.ultimo_em ? new Date(acesso.ultimo_em) : null
  const jaPediuAntes = !!desde
  if (!desde || desde < limiteRetencao) desde = limiteRetencao
  const avisoLimite = jaPediuAntes && new Date(acesso.ultimo_em) < limiteRetencao

  const { data: mensagens, error } = await supabase
    .from('whatsapp_mensagens')
    .select('apelido, texto, criado_em')
    .eq('topico', topico)
    .gte('criado_em', desde.toISOString())
    .order('criado_em', { ascending: true })
    .limit(400)
  if (error) throw error

  await supabase.from('whatsapp_resumo_ultimo_acesso').upsert({ jid, topico, ultimo_em: agora.toISOString() })

  if (!mensagens || mensagens.length === 0) {
    await sock.sendMessage(jid, { text: `Não teve conversa nova em ${NOME_TOPICO[topico]} nesse período 💛` })
    return
  }

  const linhas = mensagens.map((m) => `${m.apelido}: ${m.texto}`)
  const contexto = linhas.join('\n').slice(0, 12000)

  const resposta = await chamarGroq(promptResumo(topico), `Mensagens de ${NOME_TOPICO[topico]} (mais antiga primeiro):\n${contexto}`, 500)
  if (!resposta) {
    await sock.sendMessage(jid, { text: 'Tive um probleminha pra montar o resumo agora 😕 Tenta de novo daqui a pouco.' })
    return
  }

  const titulo = avisoLimite
    ? `✨ Resumo do ${NOME_TOPICO[topico]} (últimos ${RETENCAO_DIAS[topico]} dias — não tenho acesso anterior a isso)`
    : `✨ Resumo do ${NOME_TOPICO[topico]}`

  await sock.sendMessage(jid, { text: `${titulo}\n\n${resposta}` })
  await sock.sendMessage(jid, { text: 'Quer saber mais sobre alguma coisa? Pode perguntar aqui nos próximos 15 minutos 💬' })

  await supabase.from('whatsapp_resumo_contexto').upsert({ jid, topico, mensagens: contexto, criado_em: agora.toISOString() })
}

// Resposta de acompanhamento ("fala mais sobre X") logo depois de um resumo.
export async function responderFollowUpResumo(sock, jid, topico, mensagens, pergunta) {
  const promptSistema = `Você acabou de resumir as mensagens do tópico "${NOME_TOPICO[topico]}" do Farol Book Club pra essa pessoa. ` +
    'Agora ela quer saber mais sobre algo específico. Responda só com base nas mensagens abaixo, de forma direta e curta, em português.' +
    (topico === 'leitura' ? ' Nunca revele detalhes de enredo/trama, mesmo que pareça inofensivo.' : '')
  const resposta = await chamarGroq(promptSistema, `Mensagens:\n${mensagens}\n\nPergunta: ${pergunta}`, 400)
  await sock.sendMessage(jid, { text: resposta || 'Não consegui responder isso agora 😕' })
}
