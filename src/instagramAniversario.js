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

// Foto + @ do Instagram juntos, numa mensagem só (legenda = o @), pra admin
// postar manualmente. Só manda se tiver os dois (foto e instagram) — sem
// instagram não tem nada pra ela postar, então nem vale a pena mandar.
async function enviarFotoPV(sock, foto, instagram) {
  if (!foto || !instagram) return
  try {
    const admin = await jidAdmin()
    if (!admin) return
    await enviarMsg(sock, admin, { image: foto, caption: instagram })
  } catch (erro) {
    console.error('enviar foto aniversário (admin):', erro)
  }
}

// Parabéns de aniversário (pessoal ou tempo de clube), com foto de quem tem
// cadastrada:
// - 1 pessoa só: tenta mandar foto + texto juntos, numa mensagem só (foto
//   como post, legenda = o texto de sempre) no grupo de Avisos. Se não tiver
//   foto dela, manda só o texto (sem foto nenhuma), igual sempre foi.
// - mais de 1 pessoa no mesmo dia: manda só o texto (no plural) no grupo —
//   sem nenhuma foto ali, pra não poluir — e manda a foto de cada uma,
//   separada, só no privado da admin (legenda = @ do instagram dela).
export async function enviarAniversario(sock, { tipo, tempoTexto, pessoas, texto, mentions, grupoJid }) {
  if (pessoas.length === 1) {
    const p = pessoas[0]
    const foto = await gerarImagem(p.signupId, tipo, tempoTexto)
    try {
      if (foto) {
        await enviarMsg(sock, grupoJid, { image: foto, caption: texto, mentions })
      } else {
        await enviarMsg(sock, grupoJid, { text: texto, mentions })
      }
    } catch (erro) {
      console.error('parabéns (grupo):', erro)
    }
    await enviarFotoPV(sock, foto, p.instagram)
    return
  }

  try {
    await enviarMsg(sock, grupoJid, { text: texto, mentions })
  } catch (erro) {
    console.error('parabéns (grupo):', erro)
  }
  for (const p of pessoas) {
    const foto = await gerarImagem(p.signupId, tipo, tempoTexto)
    await enviarFotoPV(sock, foto, p.instagram)
  }
}
