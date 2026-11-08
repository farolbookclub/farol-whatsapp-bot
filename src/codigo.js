import { supabase } from './supabase.js'
import { gruposParaEnviar, grupoTemMembro, gruposFaltandoTexto } from './guia.js'

// Manda o código sempre em 2 mensagens: uma com o contexto/link, outra só
// com o código em si (sem mais nada), pra facilitar copiar e colar.
async function enviarCodigoEmDuasMensagens(sock, jid, codigo, textoIntro) {
  await sock.sendMessage(jid, { text: `${textoIntro}\nhttps://membrosfarol.vercel.app/` })
  await sock.sendMessage(jid, { text: `*${codigo}*` })
}

// Confere se o código do site mudou (rotação automática semanal ou pedido
// manual) e ainda não foi postado no Avisos do WhatsApp; posta se precisar.
export async function checarCodigoPendente(sock) {
  const { data: config } = await supabase
    .from('bot_config')
    .select('codigo_atual, codigo_trocado_em, codigo_postado_whatsapp_em')
    .eq('id', 1)
    .single()
  if (!config?.codigo_atual || !config.codigo_trocado_em) return

  const jaPostado = config.codigo_postado_whatsapp_em && new Date(config.codigo_postado_whatsapp_em) >= new Date(config.codigo_trocado_em)
  if (jaPostado) return

  const { data: grupo } = await supabase.from('whatsapp_grupos').select('group_jid').eq('topico', 'avisos').eq('ativo', true).maybeSingle()
  if (!grupo) return

  await enviarCodigoEmDuasMensagens(sock, grupo.group_jid, config.codigo_atual, '🔑 Código do site de membras:')

  await supabase.from('bot_config').update({ codigo_postado_whatsapp_em: new Date().toISOString() }).eq('id', 1)
}

// Depois que ela está de fato em todos os grupos do formato dela (Avisos,
// Bate-papo, Leitura do mês, +Presencial se for o caso), manda a mensagem
// oficial de boas-vindas + código no privado — só 1 vez (codigo_enviado).
// Chamado toda vez que ela entra em mais um grupo. Enquanto ainda falta
// algum grupo, guarda desde quando está incompleta (grupos_incompletos_desde),
// pra depois o lembrete de 1h saber quem avisar.
export async function checarEnviarCodigoSeCompleta(sock, jid, signupId, formato) {
  if (!signupId) return
  const { data: membro } = await supabase
    .from('whatsapp_membros')
    .select('codigo_enviado, grupos_incompletos_desde')
    .eq('jid', jid)
    .is('removido_em', null)
    .maybeSingle()
  if (!membro || membro.codigo_enviado) return

  const grupos = await gruposParaEnviar(formato)
  if (!grupos.length) return
  for (const g of grupos) {
    if (!(await grupoTemMembro(sock, g.group_jid, jid))) {
      if (!membro.grupos_incompletos_desde) {
        await supabase.from('whatsapp_membros').update({ grupos_incompletos_desde: new Date().toISOString() }).eq('jid', jid)
      }
      return // ainda falta algum
    }
  }

  const { data: config } = await supabase.from('bot_config').select('codigo_atual').eq('id', 1).maybeSingle()
  if (!config?.codigo_atual) return

  try {
    await sock.sendMessage(jid, { text: 'Pronto, você está oficialmente no Farol! 🎉 Bem-vinda 💖' })
    await enviarCodigoEmDuasMensagens(sock, jid, config.codigo_atual, '🔑 Código do site de membras:')
    await supabase.from('whatsapp_membros').update({ codigo_enviado: true }).eq('jid', jid)
  } catch (erro) {
    console.error(`enviar código ${jid}:`, erro)
  }
}

// Alguém já integrante pede o código de novo (ex.: "não achei o código").
// Só manda se ela já estiver em todos os grupos obrigatórios do formato
// dela; senão, avisa o que ainda falta (com link).
export async function responderPedidoCodigo(sock, jid, signupId, formato) {
  if (!signupId) return
  const r = await gruposFaltandoTexto(sock, jid, formato)
  if (!r.configurado) {
    await sock.sendMessage(jid, { text: 'Os grupos ainda não estão configurados. Chame a Administração 💖' })
    return
  }
  if (!r.completo) {
    await sock.sendMessage(jid, { text: `Falta entrar em:\n\n${r.links}\npra você estar oficialmente no clube e receber o código 💖` })
    return
  }

  const { data: config } = await supabase.from('bot_config').select('codigo_atual').eq('id', 1).maybeSingle()
  if (!config?.codigo_atual) return

  try {
    await enviarCodigoEmDuasMensagens(sock, jid, config.codigo_atual, '🔑 Código do site de membras:')
    await supabase.from('whatsapp_membros').update({ codigo_enviado: true }).eq('jid', jid)
  } catch (erro) {
    console.error(`reenviar código ${jid}:`, erro)
  }
}

// Lembrete único, 1h depois de detectar que ela entrou em algum grupo mas
// ainda não em todos: avisa o que falta, com o link só do que falta.
export async function lembrarGruposIncompletos(sock) {
  const umaHoraAtras = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const { data: membros } = await supabase
    .from('whatsapp_membros')
    .select('jid, signup_id, signups (formato)')
    .is('removido_em', null)
    .eq('codigo_enviado', false)
    .is('lembrete_grupos_enviado_em', null)
    .not('grupos_incompletos_desde', 'is', null)
    .lte('grupos_incompletos_desde', umaHoraAtras)
  if (!membros?.length) return

  for (const m of membros) {
    const formato = m.signups?.formato
    if (!formato) continue
    try {
      const r = await gruposFaltandoTexto(sock, m.jid, formato)
      if (!r.configurado || r.completo) continue // mudou de estado nesse meio-tempo
      await sock.sendMessage(m.jid, {
        text: `Verifiquei aqui e ainda falta você entrar em:\n\n${r.links}\npra você estar oficialmente no clube 💖`,
      })
      await supabase.from('whatsapp_membros').update({ lembrete_grupos_enviado_em: new Date().toISOString() }).eq('jid', m.jid)
    } catch (erro) {
      console.error(`lembrete de grupos ${m.jid}:`, erro)
    }
  }
}
