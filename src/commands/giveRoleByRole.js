async function giveRoleByRole(guild, fromRoleName, toRoleName) {
    try {
        // Fetch all members to ensure the cache is populated
        await guild.members.fetch();

        const fromRole = guild.roles.cache.find(r => r.name === fromRoleName);
        if (!fromRole) {
            return `Role "${fromRoleName}" not found.`;
        }
        const toRole = guild.roles.cache.find(r => r.name === toRoleName);
        if (!toRole) {
            return `Role "${toRoleName}" not found.`;
        }

        let given = 0;
        for (const [memberId, member] of fromRole.members) {
            if (!member.roles.cache.has(toRole.id)) {
                try {
                    await member.roles.add(toRole);
                    console.log(`Gave role "${toRoleName}" to ${member.user.tag}`);
                    given++;
                } catch (err) {
                    console.log(`Failed to give role to ${member.user.tag}: ${err.message}`);
                }
            } else {
                console.log(`${member.user.tag} already has the role "${toRoleName}"`);
            }
        }

        return `Gave role "${toRoleName}" to ${given} member(s) with the role "${fromRoleName}".`;
    } catch (error) {
        console.error('Error giving roles:', error);
        return 'An error occurred while giving roles.';
    }
}

module.exports = { giveRoleByRole };