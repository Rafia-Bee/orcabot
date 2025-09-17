async function purge(channel, amount) {
    try {
        // Discord only allows bulk delete of 2-100 messages at once and messages younger than 14 days
        if (amount < 2 || amount > 100) {
            return 'You can only delete between 2 and 100 messages at once.';
        }
        const deleted = await channel.bulkDelete(amount, true);
        return `Deleted ${deleted.size} message(s).`;
    } catch (error) {
        console.error('Error purging messages:', error);
        return 'An error occurred while deleting messages.';
    }
}

module.exports = { purge };