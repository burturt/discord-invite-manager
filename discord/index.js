const Discord = require("discord.js");
const client = new Discord.Client();
require('dotenv').config()


client.on("message", (message) => {
    console.log(message);
});

client.login(process.env.BOT_TOKEN);

module.exports = {
    async addUserToGuild(user, guild) {
        try {
            const discordUser = await client.users.fetch(user.discordId);
            const discordGuild = client.guilds.cache.get(guild);
            console.log(discordUser);
            const discordMember = await discordGuild.addMember(discordUser, {
                accessToken: user.accessToken,
            });
            return discordMember;
        } catch (error) {
            console.log(error);
            throw error;
        }
    }
}