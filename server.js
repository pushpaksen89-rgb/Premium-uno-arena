const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: { origin: "*" }
});

app.use(express.static('public'));

// --- UNO GAME STATE VARIABLE MATRIX ---
let players = []; 
let deck = [];
let discardPile = [];
let currentTurnIndex = 0;
let gameDirection = 1; // 1 means forward, -1 means reverse
let gameStarted = false;

// Generate a standard UNO deck
function createDeck() {
    const colors = ['Red', 'Blue', 'Yellow', 'Green'];
    const values = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'Skip', 'Reverse', 'Draw2'];
    let newDeck = [];

    for (let color of colors) {
        for (let value of values) {
            // Add cards to deck
            newDeck.push({ color, value });
            if (value !== '0') newDeck.push({ color, value }); // UNO has two of numbers 1-9 and actions
        }
    }
    // Add Wild cards
    for (let i = 0; i < 4; i++) {
        newDeck.push({ color: 'Wild', value: 'Wild' });
        newDeck.push({ color: 'Wild', value: 'Draw4' });
    }
    return shuffle(newDeck);
}

function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

function advanceTurn(steps = 1) {
    if (players.length === 0) return;
    currentTurnIndex = (currentTurnIndex + (steps * gameDirection) + players.length) % players.length;
}

// --- SOCKET CONNECTIONS ENGINE ---
io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    socket.on('joinGame', (username) => {
        if (gameStarted) {
            socket.emit('errorAlert', 'Game has already started!');
            return;
        }
        
        // Setup player profile structure
        const playerProfile = {
            id: socket.id,
            name: username || `Guest_${socket.id.substring(0,4)}`,
            hand: []
        };
        
        players.push(playerProfile);
        io.emit('updatePlayers', players.map(p => ({ id: p.id, name: p.name, cardCount: p.hand.length })));
    });

    socket.on('startGameSignal', () => {
        if (players.length < 2) {
            socket.emit('errorAlert', 'You need at least 2 players to start!');
            return;
        }
        
        gameStarted = true;
        deck = createDeck();
        
        // Deal 7 cards to each player profile
        players.forEach(player => {
            player.hand = deck.splice(0, 7);
        });

        // Flip top card (ensure it's not a wild card to start simple)
        let startingCard = deck.pop();
        while (startingCard.color === 'Wild') {
            deck.unshift(startingCard);
            startingCard = deck.pop();
        }
        discardPile.push(startingCard);
        currentTurnIndex = 0;
        gameDirection = 1;

        updateEntireClientState();
    });

    socket.on('playCardRequest', (cardIndex) => {
        const player = players.find(p => p.id === socket.id);
        if (!player) return;

        // RULE 1: Check if it's actually their turn
        if (players[currentTurnIndex].id !== socket.id) {
            socket.emit('errorAlert', "Wait for your turn! Don't play out of sequence.");
            return;
        }

        const cardToPlay = player.hand[cardIndex];
        const topCard = discardPile[discardPile.length - 1];

        // RULE 2: Validate if the card choice is legal under UNO guidelines
        const isValidMove = 
            cardToPlay.color === 'Wild' || 
            cardToPlay.color === topCard.color || 
            cardToPlay.value === topCard.value;

        if (!isValidMove) {
            socket.emit('errorAlert', `Invalid Card! Must match ${topCard.color} or ${topCard.value}.`);
            return;
        }

        // Move is completely legal! Execute game mechanics
        player.hand.splice(cardIndex, 1);
        discardPile.push(cardToPlay);

        // RULE 3: Process Special Action Modifiers
        let turnSteps = 1;

        if (cardToPlay.value === 'Skip') {
            turnSteps = 2; // Pass over the next player completely
        } else if (cardToPlay.value === 'Reverse') {
            gameDirection *= -1; // Invert loop direction tracking variable
            if (players.length === 2) turnSteps = 2; // In 2-player mode, Reverse acts like Skip
        } else if (cardToPlay.value === 'Draw2') {
            advanceTurn(1);
            const victim = players[currentTurnIndex];
            victim.hand.push(...deck.splice(0, 2));
            turnSteps = 1; 
        } else if (cardToPlay.value === 'Draw4') {
            advanceTurn(1);
            const victim = players[currentTurnIndex];
            victim.hand.push(...deck.splice(0, 4));
            turnSteps = 1;
        }

        // Check victory status
        if (player.hand.length === 0) {
            io.emit('gameOverEvent', `${player.name} has played their last card and won the match!`);
            gameStarted = false;
            return;
        }

        advanceTurn(turnSteps);
        updateEntireClientState();
    });

    socket.on('drawCardRequest', () => {
        if (!gameStarted) return;
        
        // Validate if it is their turn to pull from deck
        if (players[currentTurnIndex].id !== socket.id) {
            socket.emit('errorAlert', "It's not your turn to draw a card!");
            return;
        }

        const player = players[currentTurnIndex];
        
        // Recycle discard pile if drawing deck runs empty
        if (deck.length === 0) {
            const topCard = discardPile.pop();
            deck = shuffle(discardPile);
            discardPile = [topCard];
        }

        // Draw 1 card
        const drawnCard = deck.pop();
        player.hand.push(drawnCard);

        // Advance turn to next opponent automatically after drawing
        advanceTurn(1);
        updateEntireClientState();
    });

    // Handle Admin Master Engine overrides from your dashboard
    socket.on('adminForceCardDrain', (targetPlayerId) => {
        const target = players.find(p => p.id === targetPlayerId);
        if (target && target.hand.length > 0) {
            deck.push(...target.hand);
            target.hand = []; // Force dump their cards to mess with them
            updateEntireClientState();
        }
    });

    socket.on('disconnect', () => {
        players = players.filter(p => p.id !== socket.id);
        if (players.length === 0) gameStarted = false;
        io.emit('updatePlayers', players.map(p => ({ id: p.id, name: p.name, cardCount: p.hand.length })));
    });
});

// Sync data packets safely across all separate clients
function updateEntireClientState() {
    const topCard = discardPile[discardPile.length - 1];
    
    players.forEach(player => {
        io.to(player.id).emit('gameStateUpdate', {
            yourHand: player.hand,
            topCard: topCard,
            currentTurnName: players[currentTurnIndex].name,
            isYourTurn: players[currentTurnIndex].id === player.id,
            playerListSnapshot: players.map(p => ({ name: p.name, count: p.hand.length, active: p.id === players[currentTurnIndex].id }))
        });
    });
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Premium Rule-Enforced Server Online on Port ${PORT}`));