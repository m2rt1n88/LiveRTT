#pragma once

#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include "main.h"

namespace communication {
    // SWD-readable history. No allocation, formatting, RTT traffic or target-side polling.
    // Call only for complete RX frames or TX requests accepted by the transport driver.
    template <size_t Capacity, size_t MaxData>
    struct CommunicationTrace {
        struct Record {
            uint32_t sequence = 0;
            uint32_t timestamp_ms = 0;
            uint32_t identifier = 0;
            uint16_t length = 0;
            uint8_t direction = 0;  // 0: RX, 1: TX accepted (not an acknowledgement).
            uint8_t data[MaxData] = {};
        };

        volatile uint32_t revision = 0;
        volatile uint32_t total = 0;
        Record records[Capacity] = {};

        void Push(uint8_t direction, uint32_t identifier, const uint8_t* data, size_t length) {
            if (data == nullptr || length > MaxData)
                return;
            const uint32_t mask = __get_PRIMASK();
            __disable_irq();
            ++revision;
            __DMB();
            // Restart before the sequence wraps; the web reader reports a reset.
            const uint32_t next = total == UINT32_MAX ? 1 : total + 1;
            auto& record = records[(next - 1) % Capacity];
            record.sequence = 0;
            __DMB();
            record.timestamp_ms = HAL_GetTick();
            record.identifier = identifier;
            record.length = static_cast<uint16_t>(length);
            record.direction = direction;
            memcpy(record.data, data, length);
            __DMB();
            record.sequence = next;
            __DMB();
            total = next;
            __DMB();
            ++revision;
            __DMB();
            __set_PRIMASK(mask);
        }
    };
}  // namespace communication
