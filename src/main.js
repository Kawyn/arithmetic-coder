/**
 * Context for coder
 */
class CoderContext {

    static #BYTE_SIZE = 8;
    static #MAX_BYTE_VALUE = 0xff;

    /** @type {Buffer} */ input = [];
    /** @type {number[]} */ output = [];

    currentMostSignificantBits = 0;

    bounds = { min: 0, max: 0xffff };

    probabilities = new Array(CoderContext.#MAX_BYTE_VALUE + 3).fill(0).map((_, i) => i);
    cumulativeProbability = CoderContext.#MAX_BYTE_VALUE + 2;

    currentBitIdx = 0;
    currentByteIdx = 0;

    underflow = 0;

    /**
     * Pushes bit to {@link output} buffer
     * @param {0|1} bit bit to push
     */
    pushBit(bit) {

        if (this.currentBitIdx === 0)
            this.output.push(0);

        this.output[this.output.length - 1] |= (bit << (CoderContext.#BYTE_SIZE - 1 - this.currentBitIdx));
        this.currentBitIdx++;

        if (this.currentBitIdx === CoderContext.#BYTE_SIZE)
            this.currentBitIdx = 0;
    }

    /**
     * @returns {0|1} next bit from {@link input} buffer
     */
    shiftBit() {

        const byte = this.input[this.currentByteIdx];

        if (byte === undefined)
            return 0;

        const bit = byte & (1 << (CoderContext.#BYTE_SIZE - 1 - this.currentBitIdx));
        this.currentBitIdx++;

        if (this.currentBitIdx === CoderContext.#BYTE_SIZE) {

            this.currentBitIdx = 0;
            this.currentByteIdx++;
        }

        return bit > 0 ? 1 : 0;
    }
}


/**
 * Implementation of adaptive Arithmetic Coder with scaling. 
 */
class ArithmeticCoder {

    static #PRECISION = 16; // Number of bits we're working on when calculating probabilities

    /**
     * Cast number to integer with {@link ArithmeticCoder.PRECISION}
     * @param {number} x number to cast
     * @returns integer in range (0, 0xffff)
     */
    static #TO_SHORT = (x) => x & 0xffff; // or (x & (1 << PRECISION) - 1)

    static #FIRST_BIT = 0x8000; // 1000 0000 0000 0000 or (1 << (PRECISION - 1))
    static #SECOND_BIT = 0x4000; // 0100 0000 0000 0000 or (1 << (PRECISION - 2)) 

    static #GET_FIRST_BIT = (x) => x & ArithmeticCoder.#FIRST_BIT;
    static #GET_SECOND_BIT = (x) => x & ArithmeticCoder.#SECOND_BIT;

    /**
     * Encodes data using adaptive Arithmecit Encoding with scaling.
     * @param {Buffer|number[]} buffer data to encode
     * @returns {number[]} encoded data
     */
    static encode(buffer) {

        const context = new CoderContext();

        for (let i = 0; i < buffer.length; i++) {

            const symbol = buffer[i];

            this.#updateRange(context, symbol);
            this.#updateProbabilities(context, symbol);

            this.#pushBits(context)
        }

        context.pushBit(ArithmeticCoder.#GET_SECOND_BIT(context.bounds.min) !== 0 ? 1 : 0);
        context.underflow++;

        while (context.underflow > 0) {

            context.pushBit(ArithmeticCoder.#GET_SECOND_BIT(context.bounds.min) === 0 ? 1 : 0);
            context.underflow--;
        }

        return context.output;
    }

    /**
     * Decodes data using adaptive Arithmecit Encoding with scaling.
     * @param {Buffer|number[]} buffer data to decode
     * @param {number} length size of data before encoding
     * @returns decoded data
     */
    static decode(buffer, length) {

        const context = new CoderContext();

        context.input = buffer;

        for (let i = 0; i < 16; i++) {

            context.currentMostSignificantBits <<= 1;
            context.currentMostSignificantBits += context.shiftBit();
        }

        for (let i = 0; i < length; i++) {

            const probability = this.#probabilityFromCurrentBits(context);
            const symbol = this.#symbolFromCurrentProbability(context, probability);

            context.output.push(symbol);

            this.#updateRange(context, symbol);
            this.#updateProbabilities(context, symbol);

            this.#shiftBits(context);
        }

        return context.output;
    }

    /**
     * Updates bounds of given context to match probability range of given symbol
     * @param {CoderContext} context context to update
     * @param {number} symbol symbol to get probability for
     */
    static #updateRange(context, symbol) {

        const previousRange = context.bounds.max - context.bounds.min + 1;

        let offset = context.probabilities[symbol + 1] * previousRange;
        offset /= context.cumulativeProbability;

        context.bounds.max = ArithmeticCoder.#TO_SHORT(context.bounds.min + offset - 1);

        offset = context.probabilities[symbol] * previousRange;
        offset /= context.cumulativeProbability;

        context.bounds.min = ArithmeticCoder.#TO_SHORT(context.bounds.min + offset);
    }

    /**
     * Increase probability for symbol in given context and if needed rescales probabilities 
     * @param {CoderContext} context context to update
     * @param {number} symbol symbol to increase probability for
     */
    static #updateProbabilities(context, symbol) {

        context.cumulativeProbability++;

        for (let i = symbol + 1; i < context.probabilities.length; i++)
            context.probabilities[i]++;

        if (context.cumulativeProbability >= (1 << (ArithmeticCoder.#PRECISION - 2))) {

            context.cumulativeProbability = 0;

            let previous = 0;

            for (let i = 1; i < context.probabilities.length; i++) {

                const delta = context.probabilities[i] - previous;
                previous = context.probabilities[i];

                if (delta <= 2)
                    context.probabilities[i] = ArithmeticCoder.#TO_SHORT(context.probabilities[i - 1] + 1);
                else
                    context.probabilities[i] = ArithmeticCoder.#TO_SHORT(context.probabilities[i - 1] + (delta / 2));

                context.cumulativeProbability += ArithmeticCoder.#TO_SHORT(context.probabilities[i] - context.probabilities[i - 1]);
            }
        }
    }

    /**
     * Calculates probability for {@link CoderContext.currentMostSignificantBits} in given range
     * @param {CoderContext} context context to work on
     */
    static #probabilityFromCurrentBits(context) {

        const range = context.bounds.max - context.bounds.min + 1;

        let probability = (context.currentMostSignificantBits - context.bounds.min + 1);

        probability *= context.cumulativeProbability;
        probability--;

        return ArithmeticCoder.#TO_SHORT(probability / range);
    }

    /**
     * Search for symbol in given context using Binary Search
     * @param {CoderContext} context context to work on
     * @param {number} probabilities probability of symbol we want to search for
     * @returns {number} symbol
     */
    static #symbolFromCurrentProbability(context, probability) {

        let bot = 0;
        let top = context.probabilities.length;

        let mid = Math.floor(top / 2);

        while (top >= bot) {

            if (probability < context.probabilities[mid]) {

                top = mid - 1;
                mid = bot + Math.floor((top - bot) / 2);

                continue;
            }

            if (probability >= context.probabilities[mid + 1]) {

                bot = mid + 1;
                mid = bot + Math.floor((top - bot) / 2);

                continue;
            }

            return mid;
        }

        return 0;
    }

    /**
     * Pushes bits which won't change to output 
     * @param {CoderContext} context context to update
     */
    static #pushBits(context) {

        while (true) {

            if (ArithmeticCoder.#GET_FIRST_BIT(context.bounds.min) === ArithmeticCoder.#GET_FIRST_BIT(context.bounds.max)) {

                context.pushBit(ArithmeticCoder.#GET_FIRST_BIT(context.bounds.max) !== 0 ? 1 : 0);

                while (context.underflow) {

                    context.pushBit(ArithmeticCoder.#GET_FIRST_BIT(context.bounds.max) === 0 ? 1 : 0);
                    context.underflow--;
                }
            }
            else if (ArithmeticCoder.#GET_SECOND_BIT(context.bounds.min) > 0 && ArithmeticCoder.#GET_SECOND_BIT(context.bounds.max) === 0) {

                context.bounds.min &= 0x3fff;
                context.bounds.max |= ArithmeticCoder.#SECOND_BIT;

                context.underflow++;
            }
            else
                return;

            context.bounds.min = ArithmeticCoder.#TO_SHORT(context.bounds.min << 1);
            context.bounds.max = ArithmeticCoder.#TO_SHORT(context.bounds.max << 1);

            context.bounds.max |= 1;
        }
    }

    /**
     * Updates {@link CoderContext.currentMostSignificantBits} in context
     * @param {CoderContext} context context to update
     */
    static #shiftBits(context) {

        while (true) {

            if (ArithmeticCoder.#GET_FIRST_BIT(context.bounds.min) === ArithmeticCoder.#GET_FIRST_BIT(context.bounds.max)) { /* pass */ }

            else if (ArithmeticCoder.#GET_SECOND_BIT(context.bounds.min) > 0 && ArithmeticCoder.#GET_SECOND_BIT(context.bounds.max) === 0) {

                context.bounds.min &= 0x3fff;
                context.bounds.max |= ArithmeticCoder.#SECOND_BIT;

                context.currentMostSignificantBits ^= ArithmeticCoder.#SECOND_BIT;
            }
            else
                return;

            context.bounds.min = ArithmeticCoder.#TO_SHORT(context.bounds.min << 1);

            context.bounds.max = ArithmeticCoder.#TO_SHORT(context.bounds.max << 1);
            context.bounds.max |= 1;

            context.currentMostSignificantBits = ArithmeticCoder.#TO_SHORT(context.currentMostSignificantBits << 1);
            context.currentMostSignificantBits |= context.shiftBit();
        }
    }
}

module.exports = ArithmeticCoder;