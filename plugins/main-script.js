const handler = async (m, { conn }) => {
  const texto = `
 _*CREEPER🤖 *_ 🥷

\`\`\`Repositorio OFC:\`\`\`
https://github.com/TiempoMD/Creeper-bot-MD 

> 🌟 Deja tu estrellita ayudaría mucho :D

🔗 *Grupo oficial del bot:* https://chat.whatsapp.com/LfeYIFkvzZtJ8hqI1W?mode=ac_t
  `.trim()

  await conn.reply(m.chat, texto, m)
}

handler.help = ['script']
handler.tags = ['info']
handler.command = ['script']

export default handler
