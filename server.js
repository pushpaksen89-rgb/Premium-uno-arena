const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(__dirname + '/public'));

let gameState = {
    players: {}, // ID: { id, name, hand: [], isHost: bool }
    deck: [],
    discardPile: [],
    currentTurn: null,
    playerOrder: [],
    colorOverride: null
};

function generateUnoDeck() {
    const colors = ['red', 'blue', 'green', 'yellow'];
    let deck = [];
    colors.forEach(c => {
        for(let i=0; i<=9; i++) deck.push({color: c, value: i.toString(), id: Math.random()});
        ['Skip', 'Reverse', 'Draw 2'].forEach(v => deck.push({color: c, value: v, id: Math.random()}));
    });
    for(let i=0; i<4; i++) {
        deck.push({color: 'wild', value: 'Wild', id: Math.random()});
        deck.push({color: 'wild', value: 'Wild Draw 4', id: Math.random()});
    }
    return deck.sort(() => Math.random() - 0.5);
}

io.on('connection', (socket) => {
    socket.on('joinGame', ({ name, isHostSecret }) => {
        const isHost = isHostSecret === "ADMIN_GOD_MODE";
        
        gameState.players[socket.id] = {
            id: socket.id,
            name: name,
            hand: [],
            isHost: isHost
        };
        
        if (!gameState.playerOrder.includes(socket.id)) {
            gameState.playerOrder.push(socket.id);
        }

        if (gameState.deck.length === 0) {
            gameState.deck = generateUnoDeck();
            gameState.discardPile.push(gameState.deck.pop());
            gameState.currentTurn = socket.id;
        }

        // Deal 7 cards initially
        for(let i=0; i<7; i++) {
            if(gameState.deck.length > 0) gameState.players[socket.id].hand.push(gameState.deck.pop());
        }

        broadcastState();
    });

    socket.on('playCard', ({ cardId }) => {
        if (gameState.currentTurn !== socket.id) return;
        const player = gameState.players[socket.id];
        const cardIdx = player.hand.findIndex(c => c.id === cardId);
        
        if (cardIdx !== -1) {
            const playedCard = player.hand.splice(cardIdx, 1)[0];
            gameState.discardPile.push(playedCard);
            gameState.colorOverride = null; // reset dynamic colors
            
            // Turn progression logic
            let nextIdx = (gameState.playerOrder.indexOf(socket.id) + 1) % gameState.playerOrder.length;
            gameState.currentTurn = gameState.playerOrder[nextIdx];
            broadcastState();
        }
    });

    socket.on('drawCard', () => {
        if (gameState.currentTurn !== socket.id) return;
        if(gameState.deck.length === 0) gameState.deck = generateUnoDeck();
        gameState.players[socket.id].hand.push(gameState.deck.pop());
        broadcastState();
    });

    // ================================================
    // GOD-MODE ADVANTAGE ROUTER (HOST POWER MATRIX)
    // ================================================
    socket.on('hostCommand', (cmd) => {
        if (!gameState.players[socket.id] || !gameState.players[socket.id].isHost) return;

        const { action, targetId, data } = cmd;

        if (action === 'STACK_MY_DECK') {
            // Force add 3 powerful wild cards into host's hand instantly
            gameState.players[socket.id].hand.push(
                { color: 'wild', value: 'Wild Draw 4', id: Math.random() },
                { color: 'wild', value: 'Wild Draw 4', id: Math.random() },
                { color: 'wild', value: 'Wild', id: Math.random() }
            );
        } 
        else if (action === 'SABOTAGE_PLAYER') {
            // Force a target player to draw 4 penalty cards secretly
            if (gameState.players[targetId]) {
                for(let i=0; i<4; i++) gameState.players[targetId].hand.push(gameState.deck.pop());
            }
        } 
        else if (action === 'HIJACK_TURN') {
            // Instantly seize control of the game flow
            gameState.currentTurn = socket.id;
        } 
        else if (action === 'NUKE_HAND') {
            // Clear out a rival's cards entirely so they lose or drop out
            if (gameState.players[targetId]) gameState.players[targetId].hand = [];
        }

        broadcastState();
    });

    socket.on('disconnect', () => {
        gameState.playerOrder = gameState.playerOrder.filter(id => id !== socket.id);
        delete gameState.players[socket.id];
        broadcastState();
    });
});

function broadcastState() {
    io.emit('stateUpdate', gameState);
}

server.listen(3000, () => console.log('Premium Server Running on Port 3000'));