import { supabase } from './supabase.js'
import { enviarMsg } from './envio.js'
import { nomeExibicaoDoSignup } from './vinculo.js'

async function adminJid() {
  const { data } = await supabase.from('bot_config').select('admin_jid_whatsapp').eq('id', 1).maybeSingle()
  return data?.admin_jid_whatsapp || null
}

// Avisa a admin no privado quando alguém entra oficialmente no clube
// (terminou de entrar em todos os grupos), pra ela lembrar de adicionar no
// grupo do Instagram — ainda não dá pra fazer isso pela API do Instagram,
// é manual mesmo. Só avisa se tiver Instagram no cadastro; manda o @ numa
// mensagem separada, fácil de copiar. Fica "pendente" até ela confirmar
// (ver confirmarInstagramPendente, chamado pelo handleDM).
export async function avisarInstagramEntrou(sock, signupId, apelido, instagram) {
  if (!instagram) return
  const jid = await adminJid()
  if (!jid) return
  const nome = await nomeExibicaoDoSignup(signupId, apelido)
  try {
    await enviarMsg(sock, jid, { text: `📸 *${nome}* agora é membra oficial do Farol. Adicione ela no grupo do Instagram. Perfil:` })
    await enviarMsg(sock, jid, { text: instagram })
    await supabase.from('signups').update({ instagram_status: 'pendente', instagram_aviso_em: new Date().toISOString() }).eq('id', signupId)
  } catch (erro) {
    console.error('avisar instagram (entrou):', erro)
  }
}

// Avisa quando alguém sai/é removida do clube pelo próprio bot, pra admin
// lembrar de tirar do grupo do Instagram (se tiver colocado — ela adiciona
// direto por fora, sem confirmar pelo WhatsApp, então não dá pra confiar
// num status "adicionada"; manda sempre que tiver Instagram cadastrado).
export async function avisarInstagramSaiu(sock, signupId, motivo) {
  if (!signupId) return
  const { data: s } = await supabase.from('signups').select('apelido, nome, instagram').eq('id', signupId).maybeSingle()
  if (!s?.instagram) return
  const jid = await adminJid()
  const nome = await nomeExibicaoDoSignup(signupId, s.apelido || s.nome)
  const foiPorVontadePropria = motivo === 'saida_voluntaria_grupo' || motivo === 'saida_voluntaria'
  const acao = foiPorVontadePropria ? 'saiu do Farol' : 'foi removida do Farol'
  if (jid) {
    try {
      await enviarMsg(sock, jid, { text: `📸 *${nome}* (${s.instagram}) ${acao}. Se ela ainda estiver no grupo do Instagram, remova por lá.` })
    } catch (erro) {
      console.error('avisar instagram (saiu):', erro)
    }
  }
  await supabase.from('signups').update({ instagram_status: null, instagram_aviso_em: null }).eq('id', signupId)
}

// Confirmação da admin no privado ("ok"/"feito"/"não tem instagram" etc) —
// marca a inscrição "pendente" mais antiga com o status final. FIFO: se tiver
// mais de uma pendente (incomum), resolve a mais velha primeiro, que é a
// ordem natural em que ela for respondendo.
export async function confirmarInstagramPendente(novoStatus) {
  const { data: pendente } = await supabase
    .from('signups')
    .select('id, apelido, nome')
    .eq('instagram_status', 'pendente')
    .order('instagram_aviso_em', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (!pendente) return null
  await supabase.from('signups').update({ instagram_status: novoStatus }).eq('id', pendente.id)
  return { apelido: pendente.apelido || pendente.nome }
}
