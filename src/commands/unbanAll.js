async function unbanAll(guild) {
    try {
        const bans = await guild.bans.fetch();
        for (const [userId, banInfo] of bans) {
            await guild.members.unban(userId);
            console.log(`Unbanned: ${banInfo.user.tag}`);
        }
    } catch (error) {
        console.error('Error unbanning users:', error);
    }
}

module.exports = { unbanAll };