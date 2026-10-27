import { supabase } from './supabase.js'
import { GROQ_API_KEY } from './config.js'
import { dadosAtuais } from './ia.js'
import { pegarHistorico, guardarTroca } from './historico.js'

const DIA_MS = 24 * 60 * 60 * 1000
const RETENCAO_DIAS = { bate_papo: 10, leitura: 30, avisos: 30, presencial: 30 }
const NOME_TOPICO = { bate_papo: 'Bate-papo', leitura: 'Leitura do mês', avisos: 'Avisos', presencial: 'Presencial' }

async function modeloIA() {
  const { data } = await supabase.from('bot_config').select('ia_modelo').eq('id', 1).single()
  return data?.ia_modelo || 'openai/gpt-oss-20b'
}

function esperar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Tenta 1x e, se falhar (ex.: rate limit da Groq em chamadas seguidas, tipo
// resumo + pergunta de acompanhamento em sequência), tenta mais uma vez
// depois de um segundo antes de desistir.
async function chamarGroq(promptSistema, conteudo, maxTokens, historico = []) {
  const modelo = await modeloIA()
  // Modelos gpt-oss gastam parte do limite de tokens "pensando" antes de
  // responder — sem isso, a resposta visível vem cortada no meio (mesmo
  // ajuste já feito pro fluxo de pergunta direta em ia.js).
  const ehGptOss = String(modelo).startsWith('openai/gpt-oss')
  const corpo = JSON.stringify({
    model: modelo,
    temperature: 0.3,
    max_tokens: ehGptOss ? Math.max(maxTokens, 1500) : maxTokens,
    ...(ehGptOss ? { reasoning_effort: 'low' } : {}),
    messages: [
      { role: 'system', content: promptSistema },
      ...historico,
      { role: 'user', content: conteudo },
    ],
  })

  let r, json
  for (let tentativa = 1; tentativa <= 2; tentativa++) {
    r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GROQ_API_KEY}` },
      body: corpo,
    })
    json = await r.json().catch(() => null)
    if (r.ok && json?.choices?.[0]?.message?.content) break
    if (tentativa === 1) await esperar(1000)
  }

  const resposta = String(json?.choices?.[0]?.message?.content || '').trim()
  if (!r.ok || !resposta) console.error('Groq resumo:', r.status, JSON.stringify(json?.error ?? json))
  return resposta
}

const PROMPT_BASE =
  'Você resume conversas de um clube do livro (Farol Book Club), em português, tom caloroso. ' +
  'Seja CONCRETO: cite os assuntos, nomes de livros, links, códigos, datas e decisões realmente mencionados nas mensagens — ' +
  'nunca escreva algo vago tipo "o clima está leve" ou "a conversa foi descontraída" sem dizer sobre o quê. ' +
  'Se não der pra ser específico porque as mensagens são curtas ou só risadas, diga isso em uma frase, sem enfeitar. ' +
  'Nunca aponte quem não recebeu resposta, quem ficou quieta, ou qualquer coisa que possa soar como cobrança ou constranger alguém. ' +
  'Não use formatação markdown (nada de **negrito**, # título, listas com - ou *): o WhatsApp não processa isso. Se precisar destacar algo, use *asterisco simples*. ' +
  'Não escreva título nem comece com algo tipo "Resumo de..." — quem recebe a mensagem já viu um título antes dela; vá direto ao conteúdo.'

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

  // Pega as mais RECENTES desde "desde" (não as mais antigas) — senão, com
  // muita conversa no período, o assunto mais novo fica de fora do resumo.
  const { data: recentes, error } = await supabase
    .from('whatsapp_mensagens')
    .select('apelido, texto, criado_em')
    .eq('topico', topico)
    .gte('criado_em', desde.toISOString())
    .order('criado_em', { ascending: false })
    .limit(400)
  if (error) throw error
  const mensagens = (recentes ?? []).slice().reverse()

  await supabase.from('whatsapp_resumo_ultimo_acesso').upsert({ jid, topico, ultimo_em: agora.toISOString() })

  if (!mensagens || mensagens.length === 0) {
    await sock.sendMessage(jid, { text: `Não teve conversa nova em ${NOME_TOPICO[topico]} nesse período 💖` })
    return
  }

  const linhas = mensagens.map((m) => `${m.apelido}: ${m.texto}`)
  // Se ainda sobrar texto demais, corta do INÍCIO (mantém o final, mais
  // recente) — mesma lógica de priorizar o que é mais novo.
  const contexto = linhas.join('\n').slice(-12000)

  let resposta = await chamarGroq(promptResumo(topico), `Mensagens de ${NOME_TOPICO[topico]} (mais antiga primeiro):\n${contexto}`, 500)
  if (!resposta) {
    await sock.sendMessage(jid, { text: 'Tive um probleminha pra montar o resumo agora 😕 Tenta de novo daqui a pouco.' })
    return
  }
  // A IA às vezes repete um título próprio mesmo mandada não fazer isso —
  // como o título já vai separado logo abaixo, tira a 1ª linha se for um.
  resposta = resposta.replace(/^\*?resumo (d[eo]|da)\b[^\n]*\n+/i, '').trim()

  const titulo = avisoLimite
    ? `✨ Resumo do ${NOME_TOPICO[topico]} (últimos ${RETENCAO_DIAS[topico]} dias — não tenho acesso anterior a isso)`
    : `✨ Resumo do ${NOME_TOPICO[topico]}`

  await sock.sendMessage(jid, { text: `${titulo}\n\n${resposta}` })
  await sock.sendMessage(jid, { text: 'Quer saber mais sobre alguma coisa? Pode perguntar aqui nos próximos 15 minutos 💬' })

  await supabase.from('whatsapp_resumo_contexto').upsert({ jid, topico, mensagens: contexto, criado_em: agora.toISOString() })
}

// Resposta de acompanhamento ("fala mais sobre X") logo depois de um resumo.
// Além das mensagens do resumo, leva os DADOS ATUAIS reais (livro do mês,
// encontros etc.) — senão a pergunta vira só sobre o que foi dito no grupo,
// mesmo quando é algo como "qual o livro do mês" que tem resposta oficial.
export async function responderFollowUpResumo(sock, jid, topico, mensagens, pergunta) {
  const dados = await dadosAtuais()
  const promptSistema = `Você é o Faroleiro, o robô do Farol Book Club. Você acabou de resumir as mensagens do tópico "${NOME_TOPICO[topico]}" pra essa pessoa, e agora ela quer saber mais. ` +
    'Primeiro confira se a pergunta tem resposta oficial nos DADOS ATUAIS (livro do mês, leitura extra, encontros, parceiros) — se tiver, responda com base neles. ' +
    'Se for algo sobre o que foi conversado no grupo, responda com base nas MENSAGENS. Se não souber por nenhum dos dois, diga que não sabe. Responda de forma direta e curta, em português. ' +
    'Sobre data/horário/local de encontro: a ÚNICA fonte é a seção "PRÓXIMO ENCONTRO" dos DADOS ATUAIS. NUNCA deduza a data do encontro a partir de AVISOS RECENTES, das MENSAGENS ou de qualquer outra data mencionada (ex.: prazo de leitura) — só use uma data das MENSAGENS/AVISOS pra responder sobre encontro se disser literalmente que é a data do encontro.' +
    (topico === 'leitura' ? ' Nunca revele detalhes de enredo/trama, mesmo que pareça inofensivo.' : '') +
    `\n\nDADOS ATUAIS:\n${dados}`
  const resposta = await chamarGroq(promptSistema, `MENSAGENS:\n${mensagens}\n\nPergunta: ${pergunta}`, 400, pegarHistorico(jid))
  if (resposta) guardarTroca(jid, pergunta, resposta)
  await sock.sendMessage(jid, { text: resposta || 'Não consegui responder isso agora 😕' })
}
