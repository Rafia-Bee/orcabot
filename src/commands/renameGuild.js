async function renameGuild(guild, oldRoleName, newRoleName) {
    try {
        const role = guild.roles.cache.find(r => r.name === oldRoleName);
        if (!role) {
            return `Role "${oldRoleName}" not found.`;
        }
        await role.setName(newRoleName);
        console.log(`Renamed role "${oldRoleName}" to "${newRoleName}"`);
        return `Renamed role from "${oldRoleName}" to "${newRoleName}".`;
    } catch (error) {
        console.error('Error renaming guild:', error);
        return 'An error occurred while renaming the guild role.';
    }
}

module.exports = { renameGuild };