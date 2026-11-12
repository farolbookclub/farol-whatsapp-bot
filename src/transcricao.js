import { downloadMediaMessage } from '@whiskeysockets/baileys'
import { supabase } from './supabase.js'
import { enviarMsg } from './envio.js'
import { avisarAdminErro } from './pushAdmin.js'

// Só transcreve áudio desses tópicos (não Avisos).
const TOPICOS_TRANSCREVER = ['bate_papo', 'leitura', 'presencial']

// Baixa um áudio (de uma mensagem "tipo mensagem" qualquer — pode ser a
// mensagem original ou uma montada a partir de uma citação), sobe pro
// Supabase Storage e registra um pedido de transcrição. Quem transcreve de
// verdade é o ouvinte do Telegram (manda pro bot de transcrição e traz a
// resposta). chave/participante são de quem enviou o ÁUDIO (pra responder
// certinho nele depois), que pode ser diferente de quem pediu a transcrição.
async function enfileirarTranscricao(mensagemComAudio, { groupJid, msgId, participant, topico }) {
  try {
    const buffer = await downloadMediaMessage(mensagemComAudio, 'buffer', {})
    const caminho = `transcricoes/${msgId}.ogg`
    const audio = mensagemComAudio.message?.audioMessage
    const up = await supabase.storage.from('files').upload(caminho, buffer, {
      contentType: audio?.mimetype || 'audio/ogg; codecs=opus',
      upsert: true,
    })
    if (up.error) {
      console.error('upload áudio (transcrição):', up.error.message)
      return
    }
    const pub = supabase.storage.from('files').getPublicUrl(caminho)
    await supabase.from('transcricoes_pendentes').insert({
      group_jid: groupJid,
      msg_id: msgId,
      participant: participant || null,
      topico,
      audio_url: pub.data.publicUrl,
    })
  } catch (erro) {
    console.error('enfileirarTranscricao:', erro)
  }
}

// Áudio mandado direto no grupo — transcreve sozinho, sem precisar pedir.
export async function processarAudioGrupo(m, groupJid, topico) {
  if (!TOPICOS_TRANSCREVER.includes(topico)) return
  if (!m.message?.audioMessage) return
  await enfileirarTranscricao(m, { groupJid, msgId: m.key.id, participant: m.key.participant, topico })
}

// "/transcreve" respondendo um áudio (de qualquer hora, não precisa ser
// recente) — pede a transcrição manualmente daquele áudio específico.
export async function processarComandoTranscreve(m, groupJid, topico) {
  if (!TOPICOS_TRANSCREVER.includes(topico)) return false
  const citado = m.message?.extendedTextMessage?.contextInfo
  const audioCitado = citado?.quotedMessage?.audioMessage
  if (!audioCitado) return false

  const msgId = citado.stanzaId
  const participant = citado.participant
  // Monta uma "mensagem" com a chave de quem mandou o áudio original, pro
  // downloadMediaMessage conseguir buscar o arquivo certo.
  const mensagemCitada = {
    key: { remoteJid: groupJid, id: msgId, participant, fromMe: false },
    message: citado.quotedMessage,
  }
  await enfileirarTranscricao(mensagemCitada, { groupJid, msgId, participant, topico })
  return true
}

// Mesma coisa, só que no privado: áudio mandado direto pro bot no PV.
export async function processarAudioPV(m, jid) {
  if (!m.message?.audioMessage) return
  await enfileirarTranscricao(m, { groupJid: jid, msgId: m.key.id, participant: null, topico: 'pv' })
}

// "/transcreve" no privado, respondendo um áudio (dela mesma pro bot).
export async function processarComandoTranscrevePV(m, jid) {
  const citado = m.message?.extendedTextMessage?.contextInfo
  const audioCitado = citado?.quotedMessage?.audioMessage
  if (!audioCitado) return false

  const msgId = citado.stanzaId
  const mensagemCitada = { key: { remoteJid: jid, id: msgId, fromMe: false }, message: citado.quotedMessage }
  await enfileirarTranscricao(mensagemCitada, { groupJid: jid, msgId, participant: null, topico: 'pv' })
  return true
}

// Escuta (Realtime, sem polling) quando uma transcrição fica pronta e posta
// no grupo de origem, como resposta à mensagem do áudio.
const MAX_TENTATIVAS_REALTIME = 20

// Ver o comentário equivalente em avisoLeitura.js: o socket do Realtime
// reconecta sozinho por baixo, e isso pode disparar várias tentativas de
// reinscrição quase juntas — sem as proteções abaixo (1 tentativa agendada
// por vez, esperar a remoção do canal antigo terminar antes de criar o
// próximo), isso empilhava canais e timers até estourar a memória.
export function iniciarEscutaTranscricoes(getSock) {
  let tentativa = 0
  let canalAtual = null
  let tentativaAgendada = false

  function parar(motivo) {
    console.error(`Realtime (transcrições) desistiu depois de ${tentativa} tentativas — ${motivo}. Precisa reiniciar o bot.`)
    avisarAdminErro(`Realtime de transcrições parou de tentar reconectar (${tentativa}x) — reinicie o bot.`)
  }

  function agendarTentativa() {
    if (tentativaAgendada) return
    tentativaAgendada = true
    tentativa++
    if (tentativa > MAX_TENTATIVAS_REALTIME) {
      tentativaAgendada = false
      return parar('muitas falhas seguidas')
    }
    const espera = Math.min(10_000 * tentativa, 5 * 60 * 1000)
    console.error('Realtime (transcrições) caiu', `— tentando de novo em ${Math.round(espera / 1000)}s`)
    setTimeout(() => {
      tentativaAgendada = false
      assinar()
    }, espera)
  }

  async function limparCanalAtual() {
    if (!canalAtual) return
    const c = canalAtual
    canalAtual = null
    try {
      await supabase.removeChannel(c)
    } catch (erro) {
      console.error('Realtime (transcrições) erro ao remover canal:', erro)
    }
  }

  // Tudo dentro de um try/catch: o cliente de Realtime, numa rede muito
  // instável, pode lançar uma exceção síncrona bem na hora de reinscrever
  // — sem isso, essa exceção não tratada derrubava o processo inteiro do
  // bot. Agora só loga e tenta de novo mais tarde, nunca mata o Faroleiro.
  async function assinar() {
    await limparCanalAtual()
    try {
      canalAtual = supabase
        .channel(`transcricoes-realtime-${Date.now()}-${Math.random().toString(36).slice(2)}`)
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'transcricoes_pendentes' }, async (payload) => {
          const row = payload.new
          if (row.status !== 'concluido' || !row.transcricao) return
          const sock = getSock()
          if (!sock) return
          try {
            await enviarMsg(
              sock,
              row.group_jid,
              { text: `*Transcrição*:\n_"${row.transcricao}"_` },
              { quoted: { key: { remoteJid: row.group_jid, id: row.msg_id, participant: row.participant || undefined, fromMe: false }, message: { audioMessage: {} } } },
            )
          } catch (erro) {
            console.error('postar transcrição:', erro)
          }
        })
        .subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            tentativa = 0
            console.log('Escutando transcrições de áudio em tempo real.')
          }
          if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            agendarTentativa()
          }
        })
    } catch (erro) {
      console.error('Realtime (transcrições) erro ao assinar:', erro)
      agendarTentativa()
    }
  }
  assinar()
}
