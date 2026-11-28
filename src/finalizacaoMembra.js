import { supabase } from './supabase.js'
import { enviarMsg } from './envio.js'
import { avisarInstagramEntrou } from './instagramAviso.js'
import { avisarAdminEntrouSaiu } from './pushAdmin.js'
import { nomeExibicaoDoSignup } from './vinculo.js'

// Manda o código sempre em 2 mensagens: uma com o contexto/link, outra só
// com o código em si (sem mais nada), pra facilitar copiar e colar.
export async function enviarCodigoEmDuasMensagens(sock, jid, codigo, textoIntro) {
  await enviarMsg(sock, jid, { text: `${textoIntro}\nhttps://membrosfarol.vercel.app/` })
  await enviarMsg(sock, jid, { text: `*${codigo}*` })
}

// Conta individual é criada por um gatilho do banco quando ela entra
// oficialmente (provisionar-acesso-membra), que guarda a senha em
// membras.senha_provisoria pra mandar aqui. Se ainda não tiver rodado (corrida
// rara), cai no fluxo antigo de "esqueci minha senha".
async function textoAcessoSite(signupId) {
  const { data: m } = await supabase
    .from('membras')
    .select('senha_provisoria, signups(email)')
    .eq('signup_id', signupId)
    .maybeSingle()
  const email = m?.signups?.email
  const senha = m?.senha_provisoria
  if (email && senha) {
    await supabase.from('membras').update({ senha_provisoria: null }).eq('signup_id', signupId)
    return (
      '✨ *Site das membras*\n' +
      '🌐 Acesse: https://membrosfarol.vercel.app/\n\n' +
      `E-mail: ${email}\n` +
      `Senha: ${senha}\n\n` +
      'Se quiser mudar a senha, é só clicar em "Esqueci minha senha"'
    )
  }
  return (
    '✨ *Site das membras*\n' +
    'https://membrosfarol.vercel.app/\n\n' +
    'Digite o mesmo e-mail utilizado na inscrição do clube e clique em *"Esqueci minha senha"*.\n\n' +
    'Confira sua caixa de entrada ou spam e siga as instruções recebidas para cadastrar uma nova senha. Prontinho!'
  )
}

async function avisarInstagramSeTiver(sock, signupId) {
  const { data: s } = await supabase.from('signups').select('apelido, nome, instagram').eq('id', signupId).maybeSingle()
  if (!s) return
  await avisarInstagramEntrou(sock, signupId, s.apelido || s.nome, s.instagram)
}

// Avisa a admin que "entrou oficialmente" só aqui, 1x só — guardado pelo
// mesmo codigo_enviado que o resto dessa função.
async function avisarAdminEntrouOficial(signupId, formato) {
  const { data: s } = await supabase.from('signups').select('apelido, nome').eq('id', signupId).maybeSingle()
  const nome = await nomeExibicaoDoSignup(signupId, s?.apelido || s?.nome || 'Alguém')
  await avisarAdminEntrouSaiu('entrou', { apelido: nome, formato })
}

// Conclui a entrada oficial de uma integrante (manda boas-vindas + código,
// avisa Instagram e a admin) — só 1x por pessoa, guardado por
// whatsapp_membros.codigo_enviado. Chamado tanto de quando o bot detecta
// que ela entrou de fato no último grupo que faltava (codigo.js) quanto de
// quando ela termina o guia e já estava em todos os grupos (guia.js) — os
// dois caminhos levam ao mesmo lugar, sem duplicar o envio.
export async function concluirEntradaOficial(sock, jid, signupId, formato) {
  if (!signupId) return false
  const { data: membro } = await supabase.from('whatsapp_membros').select('codigo_enviado').eq('jid', jid).maybeSingle()
  if (!membro || membro.codigo_enviado) return false

  try {
    await enviarMsg(sock, jid, { text: 'Pronto, agora você faz parte do Farol! 🎀 Seja muito bem-vinda 💖' })
    await enviarMsg(sock, jid, { text: await textoAcessoSite(signupId) })
    await supabase.from('whatsapp_membros').update({ codigo_enviado: true }).eq('jid', jid)
    await avisarInstagramSeTiver(sock, signupId)
    await avisarAdminEntrouOficial(signupId, formato)
    return true
  } catch (erro) {
    console.error(`concluirEntradaOficial ${jid}:`, erro)
    return false
  }
}
