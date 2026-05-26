const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));

let rooms = {}; 
const MASTER_ADMIN_PASS = "ADMIN_GOD_MODE"; 

function generateUnoDeck() {
    const colors = ['Red', 'Blue', 'Yellow', 'Green'];
    const values = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'Skip', 'Reverse', 'Draw2'];
    let deck = [];
    for (let color of colors) {
        for (let val of values) {
            deck.push({ color: color, value: val });
            if (val !== '0') deck.push({ color: color, value: val });
        }
    }
    for (let i = 0; i < 4; i++) {
        deck.push({ color: 'Wild', value: 'Wild' });
        deck.push({ color: 'Wild', value: 'Draw4' });
    }
    return shuffle(deck);
}

function shuffle(deck) {
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

function findRoomByPlayerId(playerId) {
    for (let roomId in rooms) {
        if (rooms[roomId].players.some(p => p.id === playerId)) {
            return rooms[roomId];
        }
    }
    return null;
}

function moveToNextTurn(room) {
    let attempts = 0;
    const activePlayers = room.players.filter(p => !p.isSpectator);
    if(activePlayers.length === 0) return;
    
    do {
        if (room.direction === 1) {
            room.currentTurn = (room.currentTurn + 1) % room.players.length;
        } else {
            room.currentTurn = (room.currentTurn - 1 + room.players.length) % room.players.length;
        }
        attempts++;
    } while ((room.players[room.currentTurn].isSpectator || room.players[room.currentTurn].finished) && attempts < room.players.length);
}

function broadcastGameState(room) {
    const activePlayers = room.players.filter(p => !p.isSpectator && !p.finished);
    const currentTurnPlayer = room.players[room.currentTurn] || { name: "None", id: "" };

    room.players.forEach((p) => {
        let allHandsSnapshot = null;
        if (p.isAdmin) {
            allHandsSnapshot = room.players.map(pl => ({
                id: pl.id,
                name: pl.name,
                hand: pl.hand,
                finished: pl.finished,
                isSpectator: pl.isSpectator
            }));
        }

        io.to(p.id).emit('gameStateUpdate', {
            yourHand: p.hand,
            topCard: room.discardPile[room.discardPile.length - 1] || null,
            activeWildColor: room.activeWildColor,
            isYourTurn: (currentTurnPlayer.id === p.id && !p.isSpectator && !p.finished),
            isSpectator: p.isSpectator,
            currentTurnName: currentTurnPlayer.name,
            playerListSnapshot: room.players.map(pl => ({
                name: pl.name,
                count: pl.hand.length,
                active: (currentTurnPlayer.id === pl.id),
                finished: pl.finished,
                isSpectator: pl.isSpectator
            })),
            allPlayersHandsSnapshot: allHandsSnapshot
        });
    });
}

io.on('connection', (socket) => {
    
    socket.on('joinGame', (data) => {
        let roomId = data.room || "Arena_1";
        
        if (!rooms[roomId]) {
            rooms[roomId] = {
                id: roomId,
                players: [],
                deck: [],
                discardPile: [],
                currentTurn: 0,
                direction: 1,
                isStarted: false,
                activeWildColor: null,
                unoDeclarations: {}
            };
        }

        const room = rooms[roomId];
        const isGameLive = room.isStarted;

        const newPlayer = {
            id: socket.id,
            name: data.username || `User_${socket.id.slice(0,4)}`,
            hand: [],
            isAdmin: (data.password === MASTER_ADMIN_PASS),
            finished: false,
            isSpectator: isGameLive // Joins as spectator if the match is already running
        };

        room.players.push(newPlayer);
        socket.join(roomId);

        io.to(roomId).emit('systemNotification', `${newPlayer.name} connected to ${roomId} ${isGameLive ? 'as a Spectator' : ''}.`);
        io.to(roomId).emit('updatePlayers', room.players);
        broadcastGameState(room);
    });

    // --- INTEGRATED TEXT CHAT ROOM SIGNAL ---
    socket.on('textMessageSignal', (msg) => {
        const room = findRoomByPlayerId(socket.id);
        if(!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if(!player) return;

        io.to(room.id).emit('incomingTextMessage', { user: player.name, text: msg });
    });

    socket.on('startGameSignal', () => {
        const room = findRoomByPlayerId(socket.id);
        if (!room || room.isStarted) return;

        room.deck = generateUnoDeck();
        room.discardPile = [];
        room.isStarted = true;
        room.direction = 1;
        room.activeWildColor = null;

        // Deal cards only to active non-spectating players
        room.players.forEach(p => {
            if(!p.isSpectator) {
                p.hand = [];
                p.finished = false;
                for(let i=0; i<7; i++) p.hand.push(room.deck.pop());
            }
        });

        let startingCard = room.deck.pop();
        while(startingCard.color === 'Wild') {
            room.deck.unshift(startingCard);
            startingCard = room.deck.pop();
        }
        room.discardPile.push(startingCard);
        
        // Point turn index to the first active player
        room.currentTurn = room.players.findIndex(p => !p.isSpectator);
        if(room.currentTurn === -1) room.currentTurn = 0;

        io.to(room.id).emit('systemNotification', "The Match Grid is active! Cards dealt.");
        broadcastGameState(room);
    });

    // --- PLAY & DRAW LOGIC WITH PLAY-IMMEDIATELY RULE ---
    socket.on('drawCardRequest', () => {
        const room = findRoomByPlayerId(socket.id);
        if (!room || !room.isStarted) return;

        if (room.players[room.currentTurn].id !== socket.id) return;
        const player = room.players[room.currentTurn];

        if(room.deck.length === 0) {
            if (room.discardPile.length <= 1) return;
            const top = room.discardPile.pop();
            room.deck = shuffle(room.discardPile);
            room.discardPile = [top];
        }

        const drawnCard = room.deck.pop();
        player.hand.push(drawnCard);

        const topCard = room.discardPile[room.discardPile.length - 1];
        const isPlayable = (
            drawnCard.color === topCard.color ||
            drawnCard.value === topCard.value ||
            drawnCard.color === 'Wild' ||
            (room.activeWildColor && drawnCard.color === room.activeWildColor)
        );

        if (isPlayable) {
            io.to(room.id).emit('systemNotification', `${player.name} pulled a playable card! They can play it instantly.`);
        } else {
            io.to(room.id).emit('systemNotification', `${player.name} drew a card and passed.`);
            moveToNextTurn(room);
        }
        broadcastGameState(room);
    });

    socket.on('playCardRequest', (data) => {
        const room = findRoomByPlayerId(socket.id);
        if (!room || !room.isStarted) return;
        if (room.players[room.currentTurn].id !== socket.id) return;

        const player = room.players[room.currentTurn];
        const card = player.hand[data.index];
        if(!card) return;

        player.hand.splice(data.index, 1);
        room.discardPile.push(card);
        room.activeWildColor = data.chosenColor;

        if (card.value === 'Skip') moveToNextTurn(room);
        if (card.value === 'Reverse') room.direction *= -1;

        moveToNextTurn(room);
        broadcastGameState(room);
    });

    socket.on('declareUnoSignal', () => {
        const room = findRoomByPlayerId(socket.id);
        if(!room) return;
        const player = room.players.find(p => p.id === socket.id);
        io.to(room.id).emit('systemNotification', `📢 ${player.name} safely shouted UNO!`);
    });

    // --- ADVANCED ADVANCED GOD MODE CHANNELS ---
    socket.on('adminAddCustomCard', (data) => {
        const room = findRoomByPlayerId(socket.id);
        if (!room) return;
        const executor = room.players.find(p => p.id === socket.id);
        if (!executor || !executor.isAdmin) return;

        const target = room.players.find(p => p.id === data.targetId);
        if(target) {
            target.hand.push({ color: data.color, value: data.value });
            io.to(room.id).emit('systemNotification', `⚡ Admin injected [${data.color} ${data.value}] into ${target.name}'s hand.`);
            broadcastGameState(room);
        }
    });

    socket.on('adminSwapWildCard', (targetId) => {
        const room = findRoomByPlayerId(socket.id);
        if (!room) return;
        const executor = room.players.find(p => p.id === socket.id);
        if (!executor || !executor.isAdmin) return;

        const target = room.players.find(p => p.id === targetId);
        if(target && target.hand.length > 0) {
            // Replace their first card with a Wild Draw 4 card
            target.hand[0] = { color: 'Wild', value: 'Draw4' };
            io.to(room.id).emit('systemNotification', `⚡ Admin converted ${target.name}'s first card into a Wild Draw 4 payload.`);
            broadcastGameState(room);
        }
    });

    socket.on('adminClearCards', (targetId) => {
        const room = findRoomByPlayerId(socket.id);
        if (!room) return;
        const executor = room.players.find(p => p.id === socket.id);
        if (!executor || !executor.isAdmin) return;

        const target = room.players.find(p => p.id === targetId);
        if(target) {
            target.hand = [];
            target.finished = true;
            io.to(room.id).emit('systemNotification', `⚡ Admin purged ${target.name}'s hand to 0.`);
            moveToNextTurn(room);
            broadcastGameState(room);
        }
    });

    socket.on('voice-join', () => {
        const room = findRoomByPlayerId(socket.id);
        if (room) socket.to(room.id).emit('voice-peer-joined', socket.id);
    });
    socket.on('voice-signal', (data) => {
        io.to(data.to).emit('voice-signal', { signal: data.signal, from: socket.id });
    });

    socket.on('disconnect', () => {
        const room = findRoomByPlayerId(socket.id);
        if (room) {
            room.players = room.players.filter(p => p.id !== socket.id);
            io.to(room.id).emit('updatePlayers', room.players);
            broadcastGameState(room);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server humming on port ${PORT}`));