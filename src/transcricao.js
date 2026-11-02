import { downloadMediaMessage } from '@whiskeysockets/baileys'
import { supabase } from './supabase.js'

// Só transcreve áudio desses tópicos (não Avisos).
const TOPICOS_TRANSCREVER = ['bate_papo', 'leitura', 'presencial']

// Baixa o áudio de uma mensagem do grupo, sobe pro Supabase Storage e
// registra um pedido de transcrição. Quem transcreve de verdade é o
// ouvinte do Telegram (manda pro bot de transcrição e traz a resposta).
export async function processarAudioGrupo(m, groupJid, topico) {
  if (!TOPICOS_TRANSCREVER.includes(topico)) return
  const audio = m.message?.audioMessage
  if (!audio) return

  try {
    const buffer = await downloadMediaMessage(m, 'buffer', {})
    const caminho = `transcricoes/${m.key.id}.ogg`
    const up = await supabase.storage.from('files').upload(caminho, buffer, {
      contentType: audio.mimetype || 'audio/ogg; codecs=opus',
      upsert: true,
    })
    if (up.error) {
      console.error('upload áudio (transcrição):', up.error.message)
      return
    }
    const pub = supabase.storage.from('files').getPublicUrl(caminho)
    await supabase.from('transcricoes_pendentes').insert({
      group_jid: groupJid,
      msg_id: m.key.id,
      participant: m.key.participant || null,
      topico,
      audio_url: pub.data.publicUrl,
    })
  } catch (erro) {
    console.error('processarAudioGrupo:', erro)
  }
}

// Escuta (Realtime, sem polling) quando uma transcrição fica pronta e posta
// no grupo de origem, como resposta à mensagem do áudio.
export function iniciarEscutaTranscricoes(getSock) {
  supabase
    .channel('transcricoes-realtime')
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'transcricoes_pendentes' }, async (payload) => {
      const row = payload.new
      if (row.status !== 'concluido' || !row.transcricao) return
      const sock = getSock()
      if (!sock) return
      try {
        await sock.sendMessage(
          row.group_jid,
          { text: `*Transcrição*:\n_"${row.transcricao}"_` },
          { quoted: { key: { remoteJid: row.group_jid, id: row.msg_id, participant: row.participant || undefined, fromMe: false }, message: { audioMessage: {} } } },
        )
      } catch (erro) {
        console.error('postar transcrição:', erro)
      }
    })
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') console.log('Escutando transcrições de áudio em tempo real.')
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') console.error('Realtime (transcrições) caiu:', status)
    })
}
