import { SUPABASE_URL } from './config.js'
import { supabase } from './supabase.js'
import { enviarMsg } from './envio.js'

// Gera a imagem de aniversário (pessoal ou tempo de clube) via Edge
// Function (post-aniversario-instagram) — ela monta foto+nome(+tempo) em
// cima do template e devolve só a URL da imagem, sem postar nada sozinha
// no Instagram. É a própria Kah quem posta, manualmente, depois que o bot
// manda a foto + o @ do Instagram pra ela no privado.
const ENDPOINT = `${SUPABASE_URL}/functions/v1/post-aniversario-instagram`

async function gerarImagem(signupId, tipo, tempoTexto) {
  try {
    const r = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signup_id: signupId, tipo, tempo_texto: tempoTexto, somente_gerar: true }),
    })
    const dados = await r.json().catch(() => null)
    if (!r.ok || !dados?.imageUrl) {
      console.error('gerar imagem aniversário:', dados || r.status)
      return null
    }
    const imgResp = await fetch(dados.imageUrl)
    if (!imgResp.ok) return null
    return Buffer.from(await imgResp.arrayBuffer())
  } catch (erro) {
    console.error('gerar imagem aniversário:', erro)
    return null
  }
}

async function jidAdmin() {
  const { data } = await supabase.from('bot_config').select('admin_jid_whatsapp').eq('id', 1).maybeSingle()
  return data?.admin_jid_whatsapp || null
}

// Manda a foto pro grupo de Avisos (sem legenda — o texto dos parabéns já
// vai numa mensagem separada, igual sempre foi) e, no privado da admin, a
// mesma foto + o @ do Instagram da pessoa, pra ela postar manualmente.
async function enviarFotoAniversario(sock, signupId, foto, apelido, instagram, grupoAvisosJid) {
  if (!foto) return
  try {
    if (grupoAvisosJid) await enviarMsg(sock, grupoAvisosJid, { image: foto })
  } catch (erro) {
    console.error('enviar foto aniversário (avisos):', erro)
  }
  try {
    const admin = await jidAdmin()
    if (!admin) return
    await enviarMsg(sock, admin, { image: foto })
    await enviarMsg(sock, admin, { text: instagram || 'Sem Instagram cadastrado.' })
  } catch (erro) {
    console.error('enviar foto aniversário (admin):', erro)
  }
}

export async function postarAniversarioInstagram(sock, signupId, apelido, instagram, grupoAvisosJid) {
  if (!signupId) return
  const foto = await gerarImagem(signupId, 'pessoal')
  await enviarFotoAniversario(sock, signupId, foto, apelido, instagram, grupoAvisosJid)
}

export async function postarTempoClubeInstagram(sock, signupId, marco, apelido, instagram, grupoAvisosJid) {
  if (!signupId) return
  const foto = await gerarImagem(signupId, 'clube', `${marco} de Farol!`)
  await enviarFotoAniversario(sock, signupId, foto, apelido, instagram, grupoAvisosJid)
}
