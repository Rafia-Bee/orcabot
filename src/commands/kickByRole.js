async function kickByRole(guild, roleName) {
    try {
        // Fetch all members to ensure the cache is populated
        await guild.members.fetch();

        const role = guild.roles.cache.find(r => r.name === roleName);
        if (!role) {
            return `Role "${roleName}" not found.`;
        }

        // Now the cache should be populated
        const membersWithRole = role.members;
        let kicked = 0;

        for (const [memberId, member] of membersWithRole) {
            if (!member.kickable) {
                console.log(`Cannot kick: ${member.user.tag} (${member.id}) - Not kickable`);
                continue;
            }
            console.log(`Kicking member: ${member.user.tag} (${member.id})`);
            await member.kick(`Mass kick by role: ${roleName}`);
            kicked++;
        }

        return `Kicked ${kicked} member(s) with the role "${roleName}".`;
    } catch (error) {
        console.error('Error kicking members:', error);
        return 'An error occurred while kicking members.';
    }
}

module.exports = { kickByRole };